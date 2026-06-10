const ACTIVE_CALL_STATUSES = new Set(['dialing', 'queued', 'ringing', 'in_progress']);
const DEFAULT_REPORTING_TIME_ZONE = 'America/Los_Angeles';
const dateFormatters = new Map();

function secondsBetween(start, end = new Date()) {
  if (!start) return 0;
  const startMs = new Date(start).getTime();
  const endMs = end instanceof Date ? end.getTime() : new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.round((endMs - startMs) / 1000);
}

function dateFormatter(timeZone) {
  const key = timeZone || DEFAULT_REPORTING_TIME_ZONE;
  if (!dateFormatters.has(key)) {
    dateFormatters.set(key, new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }));
  }
  return dateFormatters.get(key);
}

function reportingDateKey(value, timeZone = DEFAULT_REPORTING_TIME_ZONE) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(
    dateFormatter(timeZone).formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function happenedOnReportingDay(record, now, timeZone = DEFAULT_REPORTING_TIME_ZONE) {
  const today = reportingDateKey(now, timeZone);
  return [record.startedAt, record.completedAt, record.endedAt, record.createdAt]
    .some((value) => reportingDateKey(value, timeZone) === today);
}

export function buildDashboardSummary(data, options = {}) {
  const now = options.now || new Date();
  const timeZone = options.timeZone || DEFAULT_REPORTING_TIME_ZONE;
  const calls = data.calls || [];
  const sessions = data.sessions || [];
  const activeCalls = calls.filter((call) => ACTIVE_CALL_STATUSES.has(call.status));
  const todayCalls = calls.filter((call) => (
    ACTIVE_CALL_STATUSES.has(call.status) || happenedOnReportingDay(call, now, timeZone)
  ));
  const todaySessions = sessions.filter((session) => happenedOnReportingDay(session, now, timeZone));

  return {
    timeZone,
    dateKey: reportingDateKey(now, timeZone),
    totalCalls: todayCalls.length,
    activeCalls: activeCalls.length,
    connected: todayCalls.filter((call) => call.outcome === 'live_answer').length,
    voicemail: todayCalls.filter((call) => call.outcome === 'voicemail').length,
    dialerSeconds: todaySessions.reduce((sum, session) => (
      sum + secondsBetween(session.startedAt, session.endedAt || now)
    ), 0)
  };
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
    abandoned: 0,
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
    if (call.outcome === 'abandoned') report.abandoned += 1;
    if (String(call.outcome || '').startsWith('canceled')) report.canceled += 1;
  }

  return [...reports.values()].sort((a, b) => b.totalCalls - a.totalCalls || a.name.localeCompare(b.name));
}
