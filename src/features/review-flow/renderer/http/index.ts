/**
 * Public HTTP-only surface. Transport adapters must not initialize ReviewFlow UI
 * or the application store while importing this entrypoint.
 */
export { createReviewFlowHttpApi } from '../createReviewFlowHttpApi';
