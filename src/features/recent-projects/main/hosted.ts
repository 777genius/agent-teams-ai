/** Exact server-only facet. Keep concrete HTTP and metadata readers off the general main barrel. */
export {
  HOSTED_RECENT_PROJECTS_ROUTE,
  registerHostedRecentProjectsHttp,
} from './adapters/input/http/registerHostedRecentProjectsHttp';
export * from './hosted/index';
