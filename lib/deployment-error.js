'use strict';

function formatDeploymentFailure(message, details) {
  if (!details || typeof details !== 'object' || !details.deployment_id) return message;
  const lines = [message, `Deployment: ${details.deployment_id}`];
  if (details.error_stage) lines.push(`Stage: ${details.error_stage}`);
  if (details.error_code) lines.push(`Error code: ${details.error_code}`);
  if (details.error_details && details.error_details !== message) {
    lines.push(`Details: ${details.error_details}`);
  }
  return lines.join('\n');
}

module.exports = { formatDeploymentFailure };
