# Package Consumption

Use one GitHub dependency:

```json
{
  "@vioxen/subscription-runtime": "github:vioxen/subscription-runtime#main"
}
```

Production services should commit their lockfile. The lockfile pins the exact
Git commit that was installed. To pull a newer `main` revision:

```bash
npm update @vioxen/subscription-runtime
```

Then rebuild and commit the lockfile.
