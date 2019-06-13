#!/usr/bin/env node

import '@babel/polyfill';
import 'fs-posix';
import S3, { NextToken, ObjectList, RoutingRules } from 'aws-sdk/clients/s3';
import yargs, { Argv } from 'yargs';
import { CACHE_FILES, Params, PluginOptions } from './constants';
import { readJson } from 'fs-extra';
import klaw from 'klaw';
import PrettyError from 'pretty-error';
import streamToPromise from 'stream-to-promise';
import ora from 'ora';
import chalk from 'chalk';
import { Readable } from 'stream';
import { relative, resolve, sep, join } from 'path';
import fs from 'fs';
import util from 'util';
import minimatch from 'minimatch';
import mime from 'mime';
import inquirer from 'inquirer';
import { config } from 'aws-sdk';
import { createHash } from 'crypto';
import isCI from 'is-ci';
import { withoutLeadingSlash } from './util';
import { parallelLimit, asyncify, AsyncFunction } from 'async';

import { getS3WebsiteDomainUrl } from './util';

const cli = yargs();
const pe = new PrettyError();

const OBJECTS_TO_REMOVE_PER_REQUEST = 1000;

const promisifiedParallelLimit: <T, E = Error>(tasks: AsyncFunction<T, E>[], limit: number) => Promise<Array<T>> = util.promisify(parallelLimit) as any; // Have to cast this due to https://github.com/DefinitelyTyped/DefinitelyTyped/issues/20497

const guessRegion = (s3: S3, constraint: void | string | undefined) => (
    constraint || s3.config.region || config.region
);

const getBucketInfo = async (config: PluginOptions, s3: S3): Promise<{ exists: boolean, region?: string }> => {
    try {
        const { $response } = await s3.getBucketLocation({ Bucket: config.bucketName }).promise();
        
        const detectedRegion = guessRegion(s3, ($response.data && $response.data.LocationConstraint));
        return {
            exists: true,
            region: detectedRegion
        };
    } catch (ex) {
        if (ex.code === 'NoSuchBucket') {
            return {
                exists: false,
                region: guessRegion(s3)
            };
        } else {
            throw ex;
        }
    }
};

const getParams = (path: string, params: Params): Partial<S3.Types.PutObjectRequest> => {
    let returned = {};
    for (const key of Object.keys(params)) {
        if (minimatch(path, key)) {
            returned = {
                ...returned,
                ...params[key]
            };
        }
    }

    return returned;
};

const listAllObjects = async (s3: S3, bucketName: string): Promise<ObjectList> => {
    const list: ObjectList = [];
    
    let token: NextToken | undefined;
    do {
        const response = await s3.listObjectsV2({
            Bucket: bucketName,
            ContinuationToken: token
        }).promise();

        if (response.Contents) {
            list.push(...response.Contents);
        }

        token = response.NextContinuationToken;
    } while(token);

    return list;
};

const createSafeS3Key = (key: string): string => {
    if (sep === '\\') {
        return key.replace(/\\/g, '/');
    }

    return key;
};

const deploy = async ({ yes, bucket }: { yes: boolean, bucket: string }) => {
    const spinner = ora({ text: 'Retrieving bucket info...', color: 'magenta' }).start();
    
    const uploadQueue:  Array<AsyncFunction<void, Error>> = [];

    try {
        const config: PluginOptions = await readJson(CACHE_FILES.config);
        const params: Params = await readJson(CACHE_FILES.params);
        const routingRules: RoutingRules = await readJson(CACHE_FILES.routingRules);
        const redirectObjects: GatsbyRedirect[] = fs.existsSync(CACHE_FILES.redirectObjects) ? await readJson(CACHE_FILES.redirectObjects) : [];

        // Override the bucket name if it is set via command line
        if (bucket) {
            config.bucketName = bucket;
        }

        const s3 = new S3({
            region: config.region,
            endpoint: config.customAwsEndpointHostname
        });

        const { exists, region } = await getBucketInfo(config, s3);

        if (isCI && !yes) {
            yes = true;
        }

        if (!yes) {
            spinner.stop();
            console.log(chalk`
    {underline Please review the following:} ({dim pass -y next time to skip this})

    Deploying to bucket: {cyan.bold ${config.bucketName}}
    In region: {yellow.bold ${region || 'UNKNOWN!'}}
    Gatsby will: ${!exists ? chalk`{bold.greenBright CREATE}` : chalk`{bold.blueBright UPDATE} {dim (any existing website configuration will be overwritten!)}`}
`);
            const { confirm } = await inquirer.prompt([{
                message: 'OK?',
                name: 'confirm',
                type: 'confirm'
            }]);

            if (!confirm) {
                throw new Error('User aborted!');
            }
            spinner.start();
        }

        spinner.text = 'Configuring bucket...';
        spinner.color = 'yellow';

        if (!exists) {
            let params: S3.Types.CreateBucketRequest = {
                Bucket: config.bucketName,
                ACL: config.acl === null ? undefined : (config.acl || 'public-read')
            };
            if (config.region) {
                params['CreateBucketConfiguration'] = {
                    LocationConstraint: config.region
                };
            }
            await s3.createBucket(params).promise();
        }

        if(!config.disableS3StaticWebsiteHosting) {
            const websiteConfig: S3.Types.PutBucketWebsiteRequest = {
                Bucket: config.bucketName,
                WebsiteConfiguration: {
                    IndexDocument: {
                        Suffix: 'index.html'
                    },
                    ErrorDocument: {
                        Key: '404.html'
                    }
                }
            };

            if (routingRules.length) {
                websiteConfig.WebsiteConfiguration.RoutingRules = routingRules;
            }

            await s3.putBucketWebsite(websiteConfig).promise();
        }

        spinner.text = 'Listing objects...';
        spinner.color = 'green';
        const objects = await listAllObjects(s3, config.bucketName);

        spinner.color = 'cyan';
        spinner.text = 'Syncing...';
        const publicDir = resolve('./public');
        const stream = klaw(publicDir);
        let isKeyInUse: { [objectKey: string]: boolean } = {};

        stream.on('data', async ({ path, stats }) => {
            if (!stats.isFile()) {
                return;
            }
            uploadQueue.push(asyncify(async () => {
                const key = createSafeS3Key(relative(publicDir, path));
                const stream = fs.createReadStream(path);
                const hashStream = stream.pipe(createHash('md5').setEncoding('hex'));
                const data = await streamToPromise(hashStream)
    
                const tag = `"${data}"`;
                const object = objects.find(object => object.Key === key && object.ETag === tag);
    
                isKeyInUse[key] = true;
            
                if (!object) {
                    try {
                        const upload = new S3.ManagedUpload({
                            service: s3,
                            params: {
                                Bucket: config.bucketName,
                                Key: key,
                                Body: fs.createReadStream(path),
                                ACL: config.acl === null ? undefined : (config.acl || 'public-read'),
                                ContentType: mime.getType(path) || 'application/octet-stream',
                                ...getParams(key, params)
                            }
                        })
        
                        upload.on('httpUploadProgress', (evt) => {
                            spinner.text = chalk`Syncing...\n{dim   Uploading {cyan ${key}} ${evt.loaded.toString()}/${evt.total.toString()}}`
                        })
        
                        await upload.promise();
                        spinner.text = chalk`Syncing...\n{dim   Uploaded {cyan ${key}}}`;
        
                    } catch (ex) {
                        console.error(ex);
                        process.exit(1);
                    }
                }

            }));
        });

        uploadQueue.push(...redirectObjects.map(redirect =>
            asyncify(async () => {
                const { fromPath, toPath: redirectLocation } = redirect;

                let key = withoutLeadingSlash(fromPath);
                if (/\/$/.test(key)) {
                    key = join(key, 'index.html');
                }

                const tag = `"${createHash('md5').update(redirectLocation).digest('hex')}"`;
                const object = objects.find(object => object.Key === key && object.ETag === tag);

                isKeyInUse[key] = true;

                if (object) {
                    // object with exact hash already exists, abort.
                    return;
                }

                try {
                    const upload = new S3.ManagedUpload({
                        service: s3,
                        params: {
                            Bucket: config.bucketName,
                            Key: key,
                            Body: redirectLocation,
                            ACL: config.acl === null ? undefined : (config.acl || 'public-read'),
                            ContentType: 'application/octet-stream',
                            WebsiteRedirectLocation: redirectLocation,
                            ...getParams(key, params)
                        }
                    });

                    await upload.promise();
            
                    spinner.text = chalk`Syncing...\n{dim   Created Redirect {cyan ${key}} => {cyan ${redirectLocation}}}\n`;
                } catch (ex) {
                    spinner.fail(chalk`Upload failure for object {cyan ${key}}`);
                    console.error(pe.render(ex));
                    process.exit(1);
                }
            })
        ))

        // now we play the waiting game.
        await streamToPromise(stream as any as Readable); // todo: find out why the typing won't allow this as-is
        await promisifiedParallelLimit(uploadQueue, 20);
        
        if (config.removeNonexistentObjects) {
            const objectsToRemove = objects.map(obj => ({ Key: <string>obj.Key })).filter(obj => obj.Key && !isKeyInUse[obj.Key]);

            for (let i = 0; i < objectsToRemove.length; i += OBJECTS_TO_REMOVE_PER_REQUEST) {
                const objectsToRemoveInThisRequest = objectsToRemove.slice(i, i + OBJECTS_TO_REMOVE_PER_REQUEST);

                spinner.text = `Removing objects ${i + 1} to ${i + objectsToRemoveInThisRequest.length} of ${objectsToRemove.length}`;
                await s3.deleteObjects({
                    Bucket: config.bucketName,
                    Delete: {
                        Objects: objectsToRemoveInThisRequest,
                        Quiet: true
                    }
                }).promise();
            }
        }

        spinner.succeed('Synced.');
        if(!config.disableS3StaticWebsiteHosting) {
            const s3WebsiteDomain = getS3WebsiteDomainUrl(region || 'us-east-1');
            console.log(chalk`
            {bold Your website is online at:}
            {blue.underline http://${config.bucketName}.${s3WebsiteDomain}}
            `);
        } else {
            console.log(chalk`
            {bold Your website has now been published to:}
            {blue.underline ${config.bucketName}}
            `);
        }
    }
    catch (ex) {
        spinner.fail('Failed.');
        console.error(pe.render(ex));
        process.exit(1);
    }
};

cli
    .command(
        ['deploy', '$0'],
        'Deploy bucket. If it doesn\'t exist, it will be created. Otherwise, it will be updated.',
        (args: Argv) => {
            args.option('yes', {
                alias: 'y',
                describe: 'Skip confirmation prompt',
                boolean: true
            });
            args.option('bucket', {
                alias: 'b',
                describe: 'Bucket name (if you wish to override default bucket name)'
            });
        },
        deploy
    )
    .wrap(cli.terminalWidth())
    .demandCommand(1, `Pass --help to see all available commands and options.`)
    .strict()
    .showHelpOnFail(true)
    .recommendCommands()
    .parse(process.argv.slice(2));

