#!/usr/bin/env bash
#
# Prints an ECS task definition ready to register: one of the templates in
# tasks/, filled in with the image, the roles, the log region, the plain
# settings from production.env and the SSM references from production.secrets.
#
# Usage: render-task-definition.sh <template> <image>
#
# Reads AWS_REGION, ECS_TASK_ROLE_ARN, ECS_TASK_EXECUTION_ROLE_ARN and
# SSM_PREFIX from the environment. Used by .github/workflows/deploy.yml.
set -euo pipefail

template="$1"
image="$2"
here="$(cd "$(dirname "$0")" && pwd)"
settings_file="$here/production.env"
secrets_file="$here/production.secrets"

for name in AWS_REGION ECS_TASK_ROLE_ARN ECS_TASK_EXECUTION_ROLE_ARN SSM_PREFIX; do
  if [ -z "${!name:-}" ]; then
    echo "render-task-definition: $name is not set" >&2
    exit 1
  fi
done

# A <placeholder> left in the settings would ship as a real value.
if grep -nE '^[A-Z0-9_]+=.*<[^>]*>' "$settings_file" >&2; then
  echo "render-task-definition: fill in the <placeholders> above in $settings_file" >&2
  exit 1
fi

# KEY=value lines, without blank lines and comments, split on the first "=".
# An empty value is kept: it is how a setting is cleared.
environment=$(grep -vE '^[[:space:]]*(#|$)' "$settings_file" |
  jq -R 'index("=") as $i | {name: .[:$i], value: .[$i + 1:]}' | jq -s .)

secrets=$(grep -vE '^[[:space:]]*(#|$)' "$secrets_file" |
  jq -R --arg prefix "$SSM_PREFIX" '{name: ., valueFrom: ($prefix + ascii_downcase)}' | jq -s .)

jq \
  --arg image "$image" \
  --arg region "$AWS_REGION" \
  --arg taskRole "$ECS_TASK_ROLE_ARN" \
  --arg executionRole "$ECS_TASK_EXECUTION_ROLE_ARN" \
  --argjson environment "$environment" \
  --argjson secrets "$secrets" \
  '.taskRoleArn = $taskRole
  | .executionRoleArn = $executionRole
  | .containerDefinitions[0].image = $image
  | .containerDefinitions[0].environment = $environment
  | .containerDefinitions[0].secrets = $secrets
  | .containerDefinitions[0].logConfiguration.options["awslogs-region"] = $region' \
  "$template"
