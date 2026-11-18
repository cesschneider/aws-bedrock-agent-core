# Per-client deployment configurations

This directory holds **non-versioned** config files for each AWS account / client deployment.
The `deployments/` folder is gitignored — copy this example folder to `deployments/` and fill in real values.

## Structure

```
deployments/
  <client-slug>.json      # one file per client/context
```

## Example config

See `deployments.example/example-client.json` for the full schema with all fields and documentation.

## Usage

```bash
# Deploy for a specific client
npx cdk deploy --app "npx ts-node bin/app.ts -c deployment=deployments/my-client.json"

# Or set the path via env var
DEPLOYMENT_CONFIG=deployments/my-client.json npx cdk deploy
```
