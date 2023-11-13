import { NetlifyIntegrationUI } from '@netlify/sdk';

const integrationUI = new NetlifyIntegrationUI('cloudinary');

const surface = integrationUI.addSurface('integrations-settings');

const route = surface.addRoute('/');

route.addSection(
  {
    title: 'Cloudinary',
    description: 'Do awesome cloudy things',
  },
  section => {}
);

route.addForm(
  {
    id: 'cloudinary-settings',
    title: 'Cloudinary Settings',
  },
  form => {
    form.addInputText({
      id: 'cloudName',
      label: 'Cloud Name',
    });

    form.addInputText({
      id: 'cname',
      label: 'CNAME',
    });

    form.addInputText({
      id: 'deliveryType',
      label: 'Delivery Type',
      placeholder: 'fetch',
    });

    form.addInputText({
      id: 'folder',
      label: 'Folder',
    });

    form.addInputText({
      id: 'imagesPath',
      label: 'Images Path',
    });

    form.addInputSelect({
      id: 'privateCdn',
      label: 'Private CDN',
      options: [
        { value: 'true', label: 'True' },
        { value: 'false', label: 'False' },
      ],
    });

    form.addInputSelect({
      id: 'loadingStrategy',
      label: 'Loading Strategy',
      options: [
        { value: 'lazy', label: 'Lazy' },
        { value: 'eager', label: 'Eager' },
      ],
    });

    form.addInputText({
      id: 'uploadPreset',
      label: 'Upload Preset',
    });
  }
);

export { integrationUI };
