/**
 * The three PromQL queries of a Poll. They are constants: nothing from a request, a response,
 * the environment or the database is ever put into them. The `service` label comes back in the
 * answer and is only compared with the known Service names.
 */

/**
 * Share of 5xx among all requests over 30 s (6 scrapes at 5 s, so a fault shows within about 30 s).
 * The `or on(service)` branch gives a zero numerator when a service has traffic but no 5xx series.
 */
export const ERROR_RATIO_QUERY =
  '(sum by (service) (rate(http_requests_total{code=~"5.."}[30s]))' +
  ' or on(service) (0 * sum by (service) (rate(http_requests_total[30s]))))' +
  ' / sum by (service) (rate(http_requests_total[30s]))';

/** p95 latency over 30 s from the duration histogram, in milliseconds. */
export const P95_MS_QUERY =
  '1000 * histogram_quantile(0.95, sum by (service, le) (rate(http_request_duration_seconds_bucket[30s])))';

/** Average of `up` over 30 s, so a redeploy blip does not read as an outage. */
export const UP_QUERY = 'avg_over_time(up{job="lab"}[30s])';

export const QUERIES = Object.freeze({
  errorRate: ERROR_RATIO_QUERY,
  p95Ms: P95_MS_QUERY,
  up: UP_QUERY,
});

/** Path of the instant query API on the Prometheus server. */
export const QUERY_PATH = '/api/v1/query';

/** A response body larger than this is refused. */
export const MAX_BODY_BYTES = 1_048_576;
