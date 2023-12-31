// Documentation: https://sdk.netlify.com
import { NetlifyIntegration, z } from '@netlify/sdk';
import path from 'path';
import fs from 'fs';
import { PUBLIC_ASSET_PATH } from './data/cloudinary';
import {
  ERROR_SITE_NAME_REQUIRED,
  ERROR_NETLIFY_HOST_UNKNOWN,
  ERROR_NETLIFY_HOST_CLI_SUPPORT,
  ERROR_CLOUD_NAME_REQUIRED,
  ERROR_API_CREDENTIALS_REQUIRED,
  ERROR_INVALID_IMAGES_PATH,
} from './data/errors.js';
import {
  Assets,
  configureCloudinary,
  getCloudinaryUrl,
  updateHtmlImagesToCloudinary,
} from './lib/cloudinary.js';
import { findAssetsByPath } from './lib/util.js';
import { glob } from 'glob';

const buildConfigSchema = z.object({
  cloudName: z.string().optional(),
  cname: z.string().optional(),
  deliveryType: z.string().optional(),
  folder: z.string().optional(),
  imagesPath: z.string().or(z.array(z.string())).optional(),
  privateCdn: z.boolean().optional(),
  loadingStrategy: z.enum(['lazy', 'eager']).optional(),
  uploadPreset: z.string().optional(),
});

type BuildConfig = z.infer<typeof buildConfigSchema>;

const integration = new NetlifyIntegration({
  buildConfigSchema,
});

const CLOUDINARY_ASSET_DIRECTORIES = [
  {
    name: 'images',
    inputKey: 'imagesPath',
    path: '/images',
  },
];

const _cloudinaryAssets = { images: {} } as Assets;

integration.onEnable(async (_, { siteId, client }) => {
  // Build event handlers are disabled by default, so we need to
  // enable them when the integration is enabled.

  siteId && (await client.enableBuildEventHandlers(siteId));

  return {
    statusCode: 200,
  };
});

integration.addBuildEventHandler(
  'onBuild',
  async ({ constants, utils, buildConfig = {}, netlifyConfig }) => {
    console.log('[Cloudinary] Creating redirects...');

    const isProduction = process.env.CONTEXT === 'production';
    const host = isProduction
      ? process.env.NETLIFY_HOST
      : process.env.DEPLOY_PRIME_URL;

    console.log(`[Cloudinary] Using host: ${host}`);

    const { PUBLISH_DIR } = constants;

    const {
      cname,
      deliveryType = 'fetch',
      folder = process.env.SITE_NAME,
      imagesPath = CLOUDINARY_ASSET_DIRECTORIES.find(
        ({ inputKey }) => inputKey === 'imagesPath'
      )?.path,
      privateCdn,
      uploadPreset,
    } = buildConfig;

    if (!folder) {
      utils.build.failPlugin(ERROR_SITE_NAME_REQUIRED);
      return;
    }

    if (!host && deliveryType === 'fetch') {
      console.warn(`[Cloudinary] ${ERROR_NETLIFY_HOST_UNKNOWN}`);
      console.log(`[Cloudinary] ${ERROR_NETLIFY_HOST_CLI_SUPPORT}`);
      return;
    }

    const cloudName =
      process.env.CLOUDINARY_CLOUD_NAME || buildConfig.cloudName;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName) {
      console.error(`[Cloudinary] ${ERROR_CLOUD_NAME_REQUIRED}`);
      utils.build.failBuild(ERROR_CLOUD_NAME_REQUIRED);
      return;
    }

    if (deliveryType === 'upload' && (!apiKey || !apiSecret)) {
      console.error(`[Cloudinary] ${ERROR_API_CREDENTIALS_REQUIRED}`);
      utils.build.failBuild(ERROR_API_CREDENTIALS_REQUIRED);
      return;
    }

    configureCloudinary({
      // Base credentials
      cloudName,
      apiKey,
      apiSecret,

      // Configuration
      cname,
      privateCdn,
    });

    // Look for any available images in the provided imagesPath to collect
    // asset details and to grab a Cloudinary URL to use later

    if (typeof imagesPath === 'undefined') {
      throw new Error(ERROR_INVALID_IMAGES_PATH);
    }

    const imagesFiles = findAssetsByPath({
      baseDir: PUBLISH_DIR,
      path: imagesPath,
    });

    if (imagesFiles.length === 0) {
      console.warn(`[Cloudinary] No image files found in ${imagesPath}`);
      console.log(
        `[Cloudinary] Did you update your images path? You can set the imagesPath input in your Netlify config.`
      );
    }

    try {
      _cloudinaryAssets.images = await Promise.all(
        imagesFiles.map(async image => {
          const publishPath = image.replace(PUBLISH_DIR, '');

          const cloudinary = await getCloudinaryUrl({
            deliveryType,
            folder,
            path: publishPath,
            localDir: PUBLISH_DIR,
            uploadPreset,
            remoteHost: host,
          });

          return {
            publishPath,
            ...cloudinary,
          };
        })
      );
    } catch (e) {
      console.error('Error', e);
      if (e instanceof Error) {
        utils.build.failBuild(e.message);
      } else {
        utils.build.failBuild(e as string);
      }
      return;
    }

    // If the delivery type is set to upload, we need to be able to map individual assets based on their public ID,
    // which would require a dynamic middle solution, but that adds more hops than we want, so add a new redirect
    // for each asset uploaded

    if (deliveryType === 'upload') {
      await Promise.all(
        Object.keys(_cloudinaryAssets).flatMap(mediaType => {
          // @ts-expect-error what are the expected mediaTypes that will be stored in _cloudinaryAssets
          return _cloudinaryAssets[mediaType].map(async asset => {
            const { publishPath, cloudinaryUrl } = asset;
            netlifyConfig.redirects.unshift({
              from: `${publishPath}*`,
              to: cloudinaryUrl,
              status: 302,
              force: true,
            });
          });
        })
      );
    }

    // If the delivery type is fetch, we're able to use the public URL and pass it right along "as is", so
    // we can create generic redirects. The tricky thing is to avoid a redirect loop, we modify the
    // path, so that we can safely allow Cloudinary to fetch the media remotely

    if (deliveryType === 'fetch') {
      await Promise.all(
        CLOUDINARY_ASSET_DIRECTORIES.map(
          async ({ inputKey, path: defaultPath }) => {
            let mediaPaths =
              buildConfig[inputKey as keyof BuildConfig] || defaultPath;

            // Unsure how to type the above so that Inputs['privateCdn'] doesnt mess up types here

            if (!Array.isArray(mediaPaths) && typeof mediaPaths !== 'string')
              return;

            if (!Array.isArray(mediaPaths)) {
              mediaPaths = [mediaPaths];
            }

            mediaPaths.forEach(async mediaPath => {
              const cldAssetPath = `/${path.join(
                PUBLIC_ASSET_PATH,
                mediaPath
              )}`;
              const cldAssetUrl = `${host}${cldAssetPath}`;

              const { cloudinaryUrl: assetRedirectUrl } =
                await getCloudinaryUrl({
                  deliveryType: 'fetch',
                  folder,
                  path: `${cldAssetUrl}/:splat`,
                  uploadPreset,
                });

              netlifyConfig.redirects.unshift({
                from: `${cldAssetPath}/*`,
                to: `${mediaPath}/:splat`,
                status: 200,
                force: true,
              });

              netlifyConfig.redirects.unshift({
                from: `${mediaPath}/*`,
                to: assetRedirectUrl,
                status: 302,
                force: true,
              });
            });
          }
        )
      );
    }

    console.log('[Cloudinary] Done.');
  }
);

integration.addBuildEventHandler(
  'onPostBuild',
  async ({ constants, buildConfig = {}, utils }) => {
    console.log(
      '[Cloudinary] Replacing on-page images with Cloudinary URLs...'
    );

    const isProduction = process.env.CONTEXT === 'production';
    const host = isProduction
      ? process.env.NETLIFY_HOST
      : process.env.DEPLOY_PRIME_URL;

    console.log(`[Cloudinary] Using host: ${host}`);

    const { PUBLISH_DIR } = constants;
    const {
      cname,
      deliveryType = 'fetch',
      folder = process.env.SITE_NAME,
      privateCdn,
      uploadPreset,
    } = buildConfig;

    if (!folder) {
      utils.build.failPlugin(ERROR_SITE_NAME_REQUIRED);
      return;
    }

    const cloudName =
      process.env.CLOUDINARY_CLOUD_NAME || buildConfig.cloudName;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName) {
      console.error(`[Cloudinary] ${ERROR_CLOUD_NAME_REQUIRED}`);
      utils.build.failBuild(ERROR_CLOUD_NAME_REQUIRED);
      return;
    }

    if (deliveryType === 'upload' && (!apiKey || !apiSecret)) {
      console.error(`[Cloudinary] ${ERROR_API_CREDENTIALS_REQUIRED}`);
      utils.build.failBuild(ERROR_API_CREDENTIALS_REQUIRED);
      return;
    }

    configureCloudinary({
      // Base credentials
      cloudName,
      apiKey,
      apiSecret,

      // Configuration
      cname,
      privateCdn,
    });

    // Find all HTML source files in the publish directory

    const pages = glob.sync(`${PUBLISH_DIR}/**/*.html`);

    const results = await Promise.all(
      pages.map(async page => {
        const sourceHtml = fs.readFileSync(page, 'utf-8');

        const { html, errors } = await updateHtmlImagesToCloudinary(
          sourceHtml,
          {
            assets: _cloudinaryAssets,
            deliveryType,
            uploadPreset,
            folder,
            localDir: PUBLISH_DIR,
            remoteHost: host,
          }
        );

        fs.writeFileSync(page, html);

        return {
          page,
          errors,
        };
      })
    );

    const errors = results.filter(({ errors }) => errors.length > 0);

    if (errors.length > 0) {
      console.log(`[Cloudinary] Done with ${errors.length} errors...`);
      console.log(JSON.stringify(errors, null, 2));
    } else {
      console.log('[Cloudinary] Done.');
    }
  }
);

export { integration };
