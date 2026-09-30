import type { HostedHttpApplication } from '../../../../core/domain';

export function registerHostedAuthFormParser(app: HostedHttpApplication): void {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      }
    );
  }
}
