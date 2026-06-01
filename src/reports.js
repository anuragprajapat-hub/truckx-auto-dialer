const ACTIVE_CALL_STATUSES = new Set(['dialing', 'queued', 'ringing', 'in_progress']);

function secondsBetween(start, end = new Date()) {
  if (!start) return 0;
  const startMs = new Date(start).getTime();
  const endMs = end instanceof Date ? end.getTime() : new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.round((endMs - startMs) / 1000);
}

function blankReport(owner) {
  return {
    ownerId: owner.id,
    hubspotOwnerId: owner.hubspotOwnerId,
    name: owner.name,
    email: owner.email || '',
    campaigns: 0,
    activeCampaigns: 0,
    dialerSeconds: 0,
    totalCalls: 0,
    activeCalls: 0,
    connected: 0,
    voicemail: 0,
    noAnswer: 0,
    busy: 0,
    failed: 0,
    canceled: 0
  };
}

export function buildAgentReports(data, now = new Date()) {
  const reports = new Map((data.owners || []).map((owner) => [owner.id, blankReport(owner)]));

  for (const campaign of data.campaigns || []) {
    const report = reports.get(campaign.ownerId);
    if (!report) continue;
    report.campaigns += 1;
    if (['running', 'connected', 'paused'].includes(campaign.status)) {
      report.activeCampaigns += 1;
    }
  }

  for (const session of data.sessions || []) {
    const report = reports.get(session.ownerId);
    if (!report) continue;
    report.dialerSeconds += secondsBetween(session.startedAt, session.endedAt || now);
  }

  for (const call of data.calls || []) {
    const report = reports.get(call.ownerId);
    if (!report) continue;
    report.totalCalls += 1;
    if (ACTIVE_CALL_STATUSES.has(call.status)) report.activeCalls += 1;
    if (call.outcome === 'live_answer') report.connected += 1;
    if (call.outcome === 'voicemail') report.voicemail += 1;
    if (call.outcome === 'no_answer') report.noAnswer += 1;
    if (call.outcome === 'busy') report.busy += 1;
    if (call.outcome === 'failed') report.failed += 1;
    if (String(call.outcome || '').startsWith('canceled')) report.canceled += 1;
  }

  return [...reports.values()].sort((a, b) => b.totalCalls - a.totalCalls || a.name.localeCompare(b.name));
}
