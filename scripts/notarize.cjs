const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  if (!process.env.APPLE_API_KEY || !process.env.APPLE_API_KEY_ID || !process.env.APPLE_API_ISSUER) {
    throw new Error('Apple notarization API credentials are required');
  }
  if (process.env.APPLE_TEAM_ID !== '86399583GS') {
    throw new Error('Unexpected Apple signing team');
  }

  const appName = context.packager.appInfo.productFilename;

  return await notarize({
    tool: 'notarytool',
    appBundleId: 'com.agent-teams.app',
    appPath: `${appOutDir}/${appName}.app`,
    appleApiKey: process.env.APPLE_API_KEY,
    appleApiKeyId: process.env.APPLE_API_KEY_ID,
    appleApiIssuer: process.env.APPLE_API_ISSUER,
  });
};
