'use strict';

function secretEntryName(value) {
  const name = typeof value === 'string' ? value.toUpperCase() : '';
  return /^[_A-Z][_A-Z0-9]{0,127}$/.test(name) &&
    !['DB', 'STORAGE', 'PROJECT_ID'].includes(name) &&
    !['JORIPSPACE_', 'CF_', 'CLOUDFLARE_'].some(prefix => name.startsWith(prefix)) ? name : '';
}

function secretManagementUrl(project, name = '') {
  const base = `https://joripspace.com/projects/${encodeURIComponent(project)}/?tab=secrets`;
  const selected = secretEntryName(name);
  return selected ? `${base}&secret_name=${encodeURIComponent(selected)}` : base;
}

function secretEntryHandoff(project, name, secrets = []) {
  const selected = secretEntryName(name);
  if (!selected) return null;
  const previous = secrets.find(secret => secret.name === selected && secret.status === 'active');
  return {
    project_id: project,
    name: selected,
    status: previous ? 'active' : 'not_registered',
    operation: previous ? 'replace' : 'create',
    previous_updated_at: previous?.updated_at || null,
    next_action: previous ? 'verify_existing_secret_or_request_replacement_if_needed' : 'show_secret_management_url_then_wait_for_user',
    verify_with: {
      cli_args: ['secret', 'list', '--project', project, '--name', selected, '--json'],
      mcp: { name: 'list_secrets', arguments: { project_id: project, name: selected } },
    },
    verification: previous
      ? 'After the user confirms saving, list secrets again and require this name to be active with updated_at newer than previous_updated_at. Then run the relevant integration check.'
      : 'After the user confirms saving, list secrets again and require this name to be active. Then run the relevant integration check.',
    instruction: 'Show the clickable secret_management_url and explain the key purpose. The name is already filled in; the user enters only the value and saves. Do not generate a placeholder value, request the value in chat, or report registration complete before verification.',
  };
}

module.exports = { secretEntryName, secretManagementUrl, secretEntryHandoff };
