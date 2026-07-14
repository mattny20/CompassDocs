# Deploy CompassDocs to Azure

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fmattny20%2FCompassDocs%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fmattny20%2FCompassDocs%2Fmain%2Fdeploy%2Fazure%2FcreateUiDefinition.json)

One click opens a guided wizard in the Azure portal that deploys the full
CompassDocs stack — the app, Postgres, and (optionally) a Caddy HTTPS proxy —
on a single Ubuntu 24.04 VM via Docker Compose, using the same `install.sh`
path as every other deployment.

## What you can configure

| Step | Options |
|---|---|
| **Basics** | VM name, region, **any VM size** (native size picker), SSH username, key or password auth |
| **Networking** | New **or existing** virtual network + subnet, public IP (new / existing / none) with a DNS label, separate CIDR restrictions for SSH and web traffic |
| **Storage** | OS disk type (Premium SSD / Standard SSD / HDD) and size, plus an optional **dedicated data disk** — formatted on first boot and mounted as Docker's data root, so the database, uploads, and backups live on it and can be snapshotted/resized independently |
| **CompassDocs** | Community or Enterprise, license key, bundled HTTPS on/off, optional headless admin bootstrap, optional Anthropic API key for AI features |

## After deployment

1. Give the VM ~2 minutes to bootstrap (progress log on the VM:
   `/var/log/compassdocs-init.log`).
2. Open the **appUrl** from the deployment outputs
   (`http://<dns-label>.<region>.cloudapp.azure.com`) and run the setup wizard.
3. With HTTPS enabled: point your own domain at the public IP, enter it in the
   setup wizard (or Settings → Domain & HTTPS), and a certificate is issued
   automatically.

## Notes

- The VM bootstraps via cloud-init user data; deployment parameters land in
  `/opt/compassdocs/.env` (mode 600) before the standard installer runs.
- The Postgres password is generated per-deployment (`newGuid()`), never shared
  or logged.
- Updating later is the standard flow on the VM:
  `cd /opt/compassdocs && sudo docker compose pull && sudo docker compose up -d`.
- Passwords passed through the wizard must not contain single quotes (they're
  embedded in the bootstrap script).
- Deleting the resource group removes everything, including data disks.
