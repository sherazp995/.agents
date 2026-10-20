---
name: devops-sre
description: DevOps and site reliability checklist. Use for CI/CD pipelines (GitHub Actions, GitLab CI), infrastructure as code (Terraform, CDK, CloudFormation), Docker and Kubernetes, deployment strategies (blue-green, canary, rolling), secrets management, monitoring and alerting, SLOs and error budgets, incident response and postmortems, capacity planning and toil automation.
---

# DevOps and SRE

The project's own `CLAUDE.md`/`AGENTS.md` wins. For service and database design load `backend-engineering`. Never print secret or env values; compare structure only.

## Delivery and infrastructure

- **Everything as code:** infrastructure in Terraform, CDK or CloudFormation under version control; pipelines in the repo; no hand-made resources.
- **Every pipeline:** build, test, security and dependency scanning, deploy, smoke check. Fail fast, cache dependencies, pin action and image versions.
- **Every deploy:** zero downtime (blue-green, canary or rolling), a health check, automatic rollback, and monitoring and alerting from the first release.
- **Secrets:** a secrets manager with rotation, never in the repo, the image or logs. Least-privilege access for pipelines and services.
- **Network and audit:** private networks by default, security groups and network policies that allow only the traffic needed, TLS in transit; audit logs for infrastructure and access changes, and automated compliance checks (for example policy-as-code) in the pipeline.
- **Environments:** dev, staging and production built from the same code with different inputs.
- **Recovery:** automated backups with a tested restore; a written disaster recovery path.
- **Cost:** right-size from measured usage, not guesses.

## Reliability

- **SLOs drive decisions:** define an SLI from what users see (for example `count(status < 500) / count(total)`), a target and a window. Budget left: ship. Budget burnt: fix reliability first.
- **Burn-rate alerts:** multi-window (for example 14.4x over 5m and 1h pages; 6x over 30m and 6h warns), not raw thresholds.
- **Golden signals:** latency (success and error separately), traffic, errors by type, saturation (CPU, memory, queue depth, connection pool).
- **Observability:** metrics for trends and alerts, logs for events, traces for the path across services.
- **Measure before optimizing;** no reliability work without data showing the problem.
- **Automate toil:** done twice by hand, automate it.
- **Progressive rollouts:** canary, then a percentage, then everyone.
- **Incidents:** severity from SLO impact; runbooks for known failures; blameless reviews that fix the system; track MTTR.

## Reporting

Lead with measured data (error budget burn, SLIs, pipeline times). Name the SLO a change puts at risk and the trade-off, with file:line for config changes.
