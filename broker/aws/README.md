# Deploying the broker to AWS Lambda

The broker (`rust/flood-broker`) runs on AWS Lambda behind a function URL:
a public HTTPS address, with no server, proxy or certificate to look after.
GitHub Actions builds it and deploys it to your account
(`.github/workflows/broker-deploy.yml`). It signs in to AWS with GitHub's
short-lived OpenID Connect token, so no AWS keys are stored in GitHub.

**Cost:** an arm64 function with 128 MB is well inside Lambda's free tier
(1 million requests and 400,000 GB-seconds a month), and function URLs are
free. The only other charge is CloudWatch logs, which are kept for 30 days.

## One-time setup (about 5 minutes)

1. **Create the AWS pieces.** Sign in to the AWS console in the region you
   want, e.g. **Asia Pacific (Sydney) ap-southeast-2**. Open CloudFormation,
   then **Create stack → With new resources**, upload
   `broker/aws/setup.yaml` and name the stack `flood-broker`. Leave the
   defaults; set `CreateGitHubOidcProvider` to `false` only if *IAM →
   Identity providers* already lists `token.actions.githubusercontent.com`.
   Tick the box acknowledging that it creates IAM roles, then create.

   It makes:
   - **The GitHub sign-in provider**, unless you set it to `false`.
   - **`flood-broker-exec`**: the role the function runs as. It can only
     write its own logs.
   - **`flood-broker-github-deploy`**: a role that only this repository's
     `main` branch can use, and only to manage the one `flood-broker`
     function.
   - **A log group** that keeps logs for 30 days.

2. **Tell GitHub where to deploy.** In the repository, open *Settings →
   Secrets and variables → Actions → Variables*. Add:
   - `AWS_DEPLOY_ROLE_ARN`: the stack's `DeployRoleArn` output.
   - `AWS_REGION`: the stack's `Region` output (`ap-southeast-2` is the
     default if you skip it).
   - Optional, `BROKER_MAX_CONCURRENCY`, e.g. `10`: a cap on how many
     copies run at once. New AWS accounts may not allow it; the deploy
     warns and carries on.

3. **Deploy.** Open *Actions → Live data broker (AWS Lambda) → Run
   workflow* on `main`. It creates the function and its URL, then
   smoke-tests both. The run's summary shows the URL, e.g.
   `https://abc123.lambda-url.ap-southeast-2.on.aws`.

4. **Point the map at it.** Add the repository variable `FLOOD_BROKER_URL`
   with that URL. The next site build (on push, or the 3-hourly schedule)
   uses it. Queensland gauge reports then show a green "live" level.

After that, every change to `rust/flood-broker` merged into `main`
redeploys the function. The URL stays the same.

## Checking on it

- **Status:** `https://<url>/health` shows uptime, cache size and calls to
  Queensland's portal, plus its last error.
- **Logs:** CloudWatch, *Log groups → /aws/lambda/flood-broker*.
- **Usage:** Lambda, *Functions → flood-broker → Monitor*.

## Notes

- **Caching:** each running copy keeps its own 10-minute cache, so a busy
  minute may ask Queensland's portal a few more times than one server
  would. Answers also carry `Cache-Control: public, max-age=300`, so
  browsers reuse them for 5 minutes.
- **Access:** the function URL is public, as the map needs. Only the map's
  own origin (`https://ghedwards.github.io`, or `BROKER_ALLOWED_ORIGINS`)
  gets CORS headers, and each address is rate-limited.
- **Removing it:** delete the `flood-broker` function in Lambda, then the
  `flood-broker` stack in CloudFormation.
