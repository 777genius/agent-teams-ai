// Browser-safe transport entrypoint: importing the API must not load UI or the app store.
export { createManagementHttpAccess } from './renderer/adapters/consumeManagementHttpAccess';
export { createExtensionManagementHttpClient } from './renderer/adapters/createExtensionManagementHttpClient';
