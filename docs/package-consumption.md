# Package Consumption

Use one GitHub dependency:

```json
{
  "@777genius/subscription-runtime": "github:777genius/subscription-runtime#main"
}
```

Production services should commit their lockfile. The lockfile pins the exact
Git commit that was installed. To pull a newer `main` revision:

```bash
npm update @777genius/subscription-runtime
```

Then rebuild and commit the lockfile.
