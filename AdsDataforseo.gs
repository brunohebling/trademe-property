/**
 * PAID ADS VIA DATAFORSEO - drop-in replacement for the Zenserp script (Multi Functions)
 * Trade Me PROPERTY
 *
 * Same jobs and schedule as the Property Zenserp script, written to DataForSEO tabs with the same
 * 8 columns (Combined Data reads these; the old AdsResultsZen* tabs keep the last Zenserp results).
 *
 *   FULL RUN       every keyword in 'Final keywords', mobile + desktop, daily at 1am
 *                  -> AdsResultsDFSMobile / AdsResultsDFSDesktop
 *   HIGH-PRIORITY  rows 2-201 of 'Final keywords', mobile + desktop, daily at 12pm and 8pm
 *                  -> AdsResultsDFSMobile_HighPriority / AdsResultsDFSDesktop_HighPriority
 *
 *   - DataForSEO SERP live/advanced, Auckland; every 'paid' item is one row, tagged top_ads / bottom_ads
 *   - each keyword is looked at the job's samplesPerKeyword times per device (full run 1,
 *     high-priority run 2), a few seconds apart,
 *     because Google does not show ads on every page load. An ad seen in ANY look is written;
 *     'No Ads Found' only when every look succeeded and none had ads
 *   - same 8 columns and the same 'No Ads Found' / 'Network Error' / 'HTTP xxx' /
 *     'Rate Limited (429)' rows as Zenserp
 *     (DataForSEO account errors are written as 'API error <code>: <message>')
 *   - one keyword per API call (as DataForSEO requires for live calls)
 *   - batches (75 keywords full / 25 high-priority), mobile -> desktop, run back to back within
 *     each step; the only pause is a short one when a step reaches its time limit
 *   - each job copies its keywords to a hidden 'DFS run keywords (full/priority)' tab when it
 *     starts, so a refresh of Final keywords mid-run doesn't change which keywords it checks
 *   - watchdog, retries, sheet lock
 *   - the two jobs keep separate progress and triggers, so they never interfere
 *   - each step uses up to ~5m45s of Google's 6-minute limit; progress is saved after every
 *     group of keywords, and a stopped run can be continued with resumeAdsDfsFullNow() /
 *     resumeAdsDfsPriorityNow()
 *
 * CHECK ONE KEYWORD: set testKeyword below and run testAdsDfsKeyword(). It logs each look and
 * the rows the script would write. Writes nothing.
 *
 * HOW TO USE
 *   One-off setup: stopAdsDfsAutomation(), removeLegacyZenserpTriggers(), setupAdsDfsSchedule().
 *   After that both jobs run by themselves; the hourly watchdog continues a stalled run.
 *   startAdsDfsPriorityNow() / startAdsDfsFullNow() run a job straight away.
 *   compareAdsParityPriority() / compareAdsParity() compare the DFS tabs with the last Zenserp
 *   results in the AdsResultsZen* tabs.
 *
 * CREDENTIALS: Script Properties DFS_LOGIN / DFS_PASSWORD if set, otherwise config.
 */

var ADS_DFS = {
  inputSheetName : 'Final keywords',

  jobs: {
    full: {
      label        : 'Full run',
      firstRow     : 2,
      lastRow      : 3001,        // stops earlier if the sheet has fewer keywords (2,064 on 1 Oct 2026)
      hours        : [1],         // 1am (script time zone)
      batchSize    : 75,          // 3 groups of 25 per step
      samplesPerKeyword: 1,       // looks per keyword per device
      parallelRequests: 25,       // ~2,000 keywords need this to finish in ~4-5 hours
      // Combined Data reads these tabs
      outputSheets : { mobile: 'AdsResultsDFSMobile', desktop: 'AdsResultsDFSDesktop' }
    },
    priority: {
      label        : 'High-priority run',
      firstRow     : 2,
      lastRow      : 201,
      hours        : [12, 20],    // 12pm and 8pm (script time zone)
      batchSize    : 25,
      samplesPerKeyword: 2,       // ads rotate between page loads, so the priority keywords get 2 looks
      parallelRequests: 5,        // 25 + 5 stays within DataForSEO's 30 simultaneous calls
      // Combined Data reads these tabs first, then the full-run tabs
      outputSheets : { mobile: 'AdsResultsDFSMobile_HighPriority', desktop: 'AdsResultsDFSDesktop_HighPriority' }
    }
  },

  // batchSize and parallelRequests are set per job above. One call takes ~8s on average
  // (up to ~16s); 25 calls at once take ~25-35s. DataForSEO allows 30 simultaneous calls.
  liveUrl        : 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
  locationCode   : 1011036,     // Auckland, New Zealand
  languageCode   : 'en',
  seDomain       : 'google.co.nz',
  depth          : 10,

  executionLimitMs   : 345000,  // every step finishes by 5m45s (Google kills executions at 6:00).
                                // A new round of calls only starts if the slowest round so far in
                                // this step would still finish before then
  minCallMs          : 30000,   // a round of calls is assumed to take at least this long
  stepGapSeconds     : 15,      // pause before the next step when a step runs out of time
                                // (Google treats it as a minimum; steps usually start within ~1 min)
  maxRunHours        : 8,
  stallMinutes       : 40,      // watchdog continues a run with no progress for this long. Longer than
                                // the longest execution seen (32 min on 9 Oct 2026), so it never starts
                                // a step while a hung one could still be alive
  maxBatchRetries    : 2,
  maxRequestRetries  : 2,       // in-batch retries for a failed keyword
  lockTimeoutMs      : 30000,
  rate429DelayMs     : 5000,

  costPerLiveCallUsd : 0.002,   // measured 2026-09-30

  testKeyword        : 'houses for sale auckland'   // used by testAdsDfsKeyword()
};

var ADS_DFS_HEADER = ['Timestamp', 'Keyword', 'Ad Type', 'Ad Position',
                      'Ad Title', 'Displayed Link', 'Ad Link', 'Ad Snippet'];

// Ad Title values for non-ad rows (same wording as the Zenserp script)
var ADS_DFS_NO_ADS  = 'No Ads Found';
var ADS_DFS_NET_ERR = 'Network Error';
var ADS_DFS_429     = 'Rate Limited (429)';

// Trigger handlers have to be named global functions, one pair per job
var ADS_DFS_HANDLERS = {
  full:     { run: 'runAdsDfsFull',     start: 'startAdsDfsFull' },
  priority: { run: 'runAdsDfsPriority', start: 'startAdsDfsPriority' }
};
var ADS_DFS_WATCHDOG = 'checkAdsDfsAbandonedFlags';

function startAdsDfsFull()     { startAdsDfsJob_('full'); }
function startAdsDfsPriority() { startAdsDfsJob_('priority'); }
function runAdsDfsFull()       { runAdsDfsJob_('full'); }
function runAdsDfsPriority()   { runAdsDfsJob_('priority'); }

/** Script Properties key for one job's run state, e.g. adsDfs_full_BatchIndex */
function adsDfsKey_(job, name) { return 'adsDfs_' + job + '_' + name; }


// ==========================================================
// SETUP / TEAR-DOWN
// ==========================================================

function setupAdsDfsSchedule() {
  removeAdsDfsSchedules();

  Object.keys(ADS_DFS.jobs).forEach(function (job) {
    ADS_DFS.jobs[job].hours.forEach(function (hour) {
      ScriptApp.newTrigger(ADS_DFS_HANDLERS[job].start).timeBased().everyDays(1).atHour(hour).nearMinute(0).create();
      console.log('✓ ' + ADS_DFS.jobs[job].label + ' scheduled daily at ' + hour + ':00');
    });
  });
  ScriptApp.newTrigger(ADS_DFS_WATCHDOG).timeBased().everyHours(1).create();
  console.log('✓ Watchdog scheduled hourly');
  adsDfsCostEstimate();
}

function removeAdsDfsSchedules() {
  var mine = [ADS_DFS_WATCHDOG];
  Object.keys(ADS_DFS_HANDLERS).forEach(function (job) {
    mine.push(ADS_DFS_HANDLERS[job].run, ADS_DFS_HANDLERS[job].start);
  });
  var deleted = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (mine.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
      deleted++;
    }
  });
  var props = PropertiesService.getScriptProperties();
  Object.keys(ADS_DFS.jobs).forEach(function (job) { props.setProperty(adsDfsKey_(job, 'Running'), 'false'); });
  console.log('Removed ' + deleted + ' DFS ads trigger(s).');
}

/** Go-live step: deletes every trigger for the old Zenserp handlers (full and high-priority). */
function removeLegacyZenserpTriggers() {
  var legacy = ['runZenserpAutomation', 'startZenserpAutomation', 'checkAbandonedFlags',
                'runHighPriorityBatchMobile', 'runHighPriorityBatchDesktop',
                'getZenserpAdsMobile', 'getZenserpAdsDesktop'];
  var deleted = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (legacy.indexOf(h) !== -1 || /zenserp/i.test(h)) {
      ScriptApp.deleteTrigger(t);
      deleted++;
    }
  });
  PropertiesService.getScriptProperties().setProperty('zenserpRunning', 'false');
  console.log('Removed ' + deleted + ' legacy Zenserp trigger(s).');
  var left = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  console.log('Triggers still in this project: ' + (left.length ? left.join(', ') : 'none'));
}

function adsDfsCostEstimate() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ADS_DFS.inputSheetName);
  var perDay = 0;
  Object.keys(ADS_DFS.jobs).forEach(function (job) {
    var cfg = ADS_DFS.jobs[job];
    var keywords = Math.max(0, Math.min(cfg.lastRow, adsDfsLastRow_(sheet, cfg.firstRow)) - cfg.firstRow + 1);
    var calls = keywords * 2 * cfg.samplesPerKeyword;
    var perRun = calls * ADS_DFS.costPerLiveCallUsd;
    perDay += perRun * cfg.hours.length;
    console.log(cfg.label + ': ' + keywords + ' keywords × 2 devices × ' + cfg.samplesPerKeyword +
               ' looks = ' + calls + ' calls, $' + perRun.toFixed(2) + ' per run × ' + cfg.hours.length + ' run(s)/day');
  });
  console.log('Total per day: $' + perDay.toFixed(2));
}


// ==========================================================
// START / STOP / WATCHDOG
// ==========================================================

function startAdsDfsFullNow()     { adsDfsStartNow_('full'); }
function startAdsDfsPriorityNow() { adsDfsStartNow_('priority'); }

/**
 * Continue a stopped or stalled run from where it got to (same device, batch and keyword),
 * keeping the rows already written. Use startAdsDfsFullNow() / startAdsDfsPriorityNow()
 * instead to start again from scratch.
 */
function resumeAdsDfsFullNow()     { adsDfsResumeNow_('full'); }
function resumeAdsDfsPriorityNow() { adsDfsResumeNow_('priority'); }

function adsDfsResumeNow_(job) {
  var props = PropertiesService.getScriptProperties();
  var k = function (n) { return adsDfsKey_(job, n); };
  props.setProperty(k('Running'), 'true');
  props.setProperty(k('StartTime'), new Date().toISOString());   // fresh 8h for the watchdog
  props.setProperty(k('LastProgress'), new Date().toISOString());
  props.setProperty(k('RetryCount'), '0');
  deleteAdsDfsBatchTriggers_(job);
  ScriptApp.newTrigger(ADS_DFS_HANDLERS[job].run).timeBased().after(ADS_DFS.stepGapSeconds * 1000).create();
  console.log('Resuming ' + ADS_DFS.jobs[job].label + ' shortly: ' + (props.getProperty(k('Device')) || 'mobile') +
              ' batch ' + (parseInt(props.getProperty(k('BatchIndex')) || '0', 10) + 1) +
              ', keyword offset ' + (props.getProperty(k('Offset')) || '0'));
}

function adsDfsStartNow_(job) {
  PropertiesService.getScriptProperties().setProperty(adsDfsKey_(job, 'Running'), 'false');
  deleteAdsDfsBatchTriggers_(job);
  startAdsDfsJob_(job);
}

function startAdsDfsJob_(job) {
  var props = PropertiesService.getScriptProperties();
  var k = function (n) { return adsDfsKey_(job, n); };

  if (props.getProperty(k('Running')) === 'true') {
    var startDate = new Date(props.getProperty(k('StartTime')) || '');
    if (!isNaN(startDate.getTime()) && (new Date() - startDate) / 3600000 <= ADS_DFS.maxRunHours) {
      console.log(ADS_DFS.jobs[job].label + ' already in progress. Skipping.');
      return;
    }
    console.log('⚠️ Stale ' + ADS_DFS.jobs[job].label + '. Auto-recovering.');
    deleteAdsDfsBatchTriggers_(job);
  }

  if (adsDfsTakeSnapshot_(job) === 0) {
    console.log('✗ No keywords in ' + ADS_DFS.inputSheetName + ' for the ' + ADS_DFS.jobs[job].label + '. Not started.');
    return;
  }

  props.setProperty(k('Running'), 'true');
  props.setProperty(k('Device'), 'mobile');
  props.setProperty(k('BatchIndex'), '0');
  props.setProperty(k('Offset'), '0');
  props.setProperty(k('StartTime'), new Date().toISOString());
  props.setProperty(k('LastProgress'), new Date().toISOString());
  props.setProperty(k('RetryCount'), '0');
  deleteAdsDfsBatchTriggers_(job);

  console.log('================ STARTING ' + ADS_DFS.jobs[job].label.toUpperCase() + ' ================');

  try {
    ScriptApp.newTrigger(ADS_DFS_HANDLERS[job].run).timeBased().after(ADS_DFS.stepGapSeconds * 1000).create();
  } catch (e) {
    props.setProperty(k('Running'), 'false');
    props.setProperty(k('StartupFailure'), new Date().toISOString() + ': ' + e.message);
    throw e;
  }
}

/** Stops both jobs. The daily schedule stays. */
function stopAdsDfsAutomation() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(ADS_DFS.jobs).forEach(function (job) {
    props.setProperty(adsDfsKey_(job, 'Running'), 'false');
    props.setProperty(adsDfsKey_(job, 'StoppedReason'), 'manual_' + new Date().toISOString());
    deleteAdsDfsBatchTriggers_(job);
  });
  console.log('DFS ads automation stopped.');
}

/** Hourly watchdog: per job, clears a run stuck for more than maxRunHours and continues a stalled one. */
function checkAdsDfsAbandonedFlags() {
  Object.keys(ADS_DFS.jobs).forEach(function (job) {
    adsDfsCheckAbandoned_(job);
    adsDfsResumeIfStalled_(job);
  });
}

/**
 * A run is stalled when it is marked running but has made no progress for stallMinutes.
 * Progress is saved at the start of every step and after every group of keywords, so a healthy
 * run never goes that long without it. A leftover trigger does not count as "next step
 * scheduled": on 9 Oct 2026 a step hung inside Google's trigger service for 32 minutes and left
 * a used one-off trigger behind, and the old check (which trusted that trigger) never resumed the
 * run. The watchdog now removes any leftover step trigger and continues the run from where it
 * got to, keeping the rows already written.
 */
function adsDfsResumeIfStalled_(job) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(adsDfsKey_(job, 'Running')) !== 'true') return;
  var last = new Date(props.getProperty(adsDfsKey_(job, 'LastProgress')) || props.getProperty(adsDfsKey_(job, 'StartTime')) || '');
  if (isNaN(last.getTime()) || new Date() - last < ADS_DFS.stallMinutes * 60 * 1000) return;
  console.log('⚠️ [WATCHDOG] ' + ADS_DFS.jobs[job].label + ' stalled (no progress since ' +
              last.toISOString() + '). Continuing it.');
  props.setProperty(adsDfsKey_(job, 'WatchdogResumed'), new Date().toISOString());
  scheduleNextAdsDfs_(job, ADS_DFS.stepGapSeconds);   // also deletes any leftover step trigger
}

function adsDfsCheckAbandoned_(job) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(adsDfsKey_(job, 'Running')) !== 'true') return;

  var startDate = new Date(props.getProperty(adsDfsKey_(job, 'StartTime')) || '');
  var hours = isNaN(startDate.getTime()) ? null : (new Date() - startDate) / 3600000;

  if (hours === null || hours > ADS_DFS.maxRunHours) {
    console.log('⚠️ [WATCHDOG] Clearing stuck ' + ADS_DFS.jobs[job].label + '.');
    props.setProperty(adsDfsKey_(job, 'Running'), 'false');
    props.setProperty(adsDfsKey_(job, 'StoppedReason'), 'watchdog_' + new Date().toISOString());
    deleteAdsDfsBatchTriggers_(job);
  }
}

function deleteAdsDfsBatchTriggers_(job) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === ADS_DFS_HANDLERS[job].run) ScriptApp.deleteTrigger(t);
  });
}

function scheduleNextAdsDfs_(job, delaySeconds) {
  var handler = ADS_DFS_HANDLERS[job].run;
  deleteAdsDfsBatchTriggers_(job);
  try {
    ScriptApp.newTrigger(handler).timeBased().after(delaySeconds * 1000).create();
  } catch (e) {
    console.log('⚠️ Trigger creation failed: ' + e.message);
    Utilities.sleep(5000);
    try {
      ScriptApp.newTrigger(handler).timeBased().after((delaySeconds + 60) * 1000).create();
    } catch (e2) {
      PropertiesService.getScriptProperties().setProperty(adsDfsKey_(job, 'TriggerFailed'), new Date().toISOString());
      console.log('✗ Trigger creation failed again: ' + e2.message);
    }
  }
}


// ==========================================================
// ORCHESTRATOR
// ==========================================================

function runAdsDfsJob_(job) {
  var executionStart = new Date();
  var props = PropertiesService.getScriptProperties();
  var cfg = ADS_DFS.jobs[job];
  var k = function (n) { return adsDfsKey_(job, n); };

  adsDfsCheckAbandoned_(job);
  if (props.getProperty(k('Running')) !== 'true') {
    deleteAdsDfsBatchTriggers_(job);
    return;
  }

  // Safety net: if Google kills this execution before it finishes, this trigger resumes the
  // run from the last saved keyword. It is replaced by the normal trigger at the end.
  scheduleNextAdsDfs_(job, 7 * 60);
  props.setProperty(k('LastProgress'), new Date().toISOString());

  var batches = adsDfsBuildBatches_(job);
  var clock = adsDfsClock_(executionStart.getTime());   // one time budget for every batch in this step
  var firstInStep = true;
  console.log('Step start: ' + cfg.label);

  // Batches run back to back until the run is done or this step is out of time
  while (true) {
    var device   = props.getProperty(k('Device')) || 'mobile';
    var batchIdx = parseInt(props.getProperty(k('BatchIndex')) || '0', 10);
    var offset   = parseInt(props.getProperty(k('Offset')) || '0', 10);

    if (batchIdx >= batches.length) {
      console.log('✓ ' + cfg.label + ' complete.');
      props.setProperty(k('Running'), 'false');
      props.setProperty(k('CompletedAt'), new Date().toISOString());
      deleteAdsDfsBatchTriggers_(job);
      return;
    }

    if (!firstInStep && !clock.canStart()) {
      // No time left for another batch: the next step carries on after a short pause
      scheduleNextAdsDfs_(job, ADS_DFS.stepGapSeconds);
      return;
    }

    var batch = batches[batchIdx];
    console.log(cfg.label + ' | ' + device + ' batch ' + (batchIdx + 1) + '/' + batches.length +
                ' (rows ' + batch.start + '-' + batch.end + '), keyword offset ' + offset);

    var result;
    try {
      result = getAdsDfsBatch_(job, device, batch.start, batch.end, batchIdx === 0 && offset === 0, offset,
                               executionStart, clock, firstInStep);
      props.setProperty(k('RetryCount'), '0');
    } catch (e) {
      var retryCount = parseInt(props.getProperty(k('RetryCount')) || '0', 10);
      if (retryCount >= ADS_DFS.maxBatchRetries) {
        console.log('✗ Batch ' + batchIdx + ' (' + device + ') failed ' + (retryCount + 1) + ' times (' + e.message + '). Skipping.');
        props.setProperty(k('LastBatch'), device + '_' + batchIdx + '_skipped');
        props.setProperty(k('RetryCount'), '0');
        adsDfsAdvance_(job, device, batchIdx);
        scheduleNextAdsDfs_(job, ADS_DFS.stepGapSeconds);
        return;
      }
      console.log('⚠️ Batch error: ' + e.message + ' (retry ' + (retryCount + 1) + '/' + ADS_DFS.maxBatchRetries + ')');
      props.setProperty(k('RetryCount'), String(retryCount + 1));
      scheduleNextAdsDfs_(job, 2 * 60);
      return;
    }
    firstInStep = false;

    if (!result.complete) {
      // Out of time mid-batch: the next step continues from where this one stopped
      props.setProperty(k('Offset'), String(result.nextOffset));
      scheduleNextAdsDfs_(job, ADS_DFS.stepGapSeconds);
      return;
    }

    props.setProperty(k('LastBatch'), device + '_' + batchIdx + '_ok');
    props.setProperty(k('LastBatchTime'), new Date().toISOString());
    adsDfsAdvance_(job, device, batchIdx);
  }
}

// ==========================================================
// KEYWORD SNAPSHOT
// 'Final keywords' is a formula that changes size and order whenever Ads Keyword Metrics
// refreshes. Each run copies its keywords once when it starts and works from that copy, so a
// refresh mid-run can't end the run early or make it skip or repeat keywords.
// ==========================================================

function adsDfsSnapshotName_(job) { return 'DFS run keywords (' + job + ')'; }

/** Copies the job's keyword rows from Final keywords into its (hidden) snapshot tab. Returns the count. */
function adsDfsTakeSnapshot_(job) {
  var cfg = ADS_DFS.jobs[job];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(ADS_DFS.inputSheetName);
  if (!src) throw new Error('Input sheet not found: ' + ADS_DFS.inputSheetName);
  var last = Math.min(cfg.lastRow, adsDfsLastRow_(src, cfg.firstRow));
  var kws = last < cfg.firstRow ? [] :
    src.getRange(cfg.firstRow, 1, last - cfg.firstRow + 1, 1).getValues()
       .map(function (r) { return String(r[0] || '').trim(); })
       .filter(String)
       .map(function (kw) { return [kw]; });
  var name = adsDfsSnapshotName_(job);
  var snap = ss.getSheetByName(name) || ss.insertSheet(name);
  snap.clear();
  snap.getRange(1, 1, kws.length + 1, 1).setValues([['Keyword']].concat(kws));
  if (!snap.isSheetHidden()) snap.hideSheet();
  console.log(cfg.label + ' keyword snapshot: ' + kws.length + ' keywords copied from ' + ADS_DFS.inputSheetName);
  return kws.length;
}

/** The job's snapshot tab for the current run (taken now if it doesn't exist yet). Rows start at 2. */
function adsDfsKeywordSheet_(job) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var snap = ss.getSheetByName(adsDfsSnapshotName_(job));
  if (!snap || snap.getLastRow() < 2) {
    adsDfsTakeSnapshot_(job);
    snap = ss.getSheetByName(adsDfsSnapshotName_(job));
  }
  return snap;
}

/** Batches of batchSize rows of the job's keyword snapshot. */
function adsDfsBuildBatches_(job) {
  var cfg = ADS_DFS.jobs[job];
  var sheet = adsDfsKeywordSheet_(job);
  var last = Math.min(cfg.lastRow, adsDfsLastRow_(sheet, cfg.firstRow));
  var batches = [];
  for (var s = cfg.firstRow; s <= last; s += cfg.batchSize) {
    batches.push({ start: s, end: Math.min(s + cfg.batchSize - 1, last) });
  }
  return batches;
}

/** Last row with a keyword in column A (ignores formulas returning ''). */
function adsDfsLastRow_(sheet, firstRow) {
  if (!sheet || sheet.getLastRow() < firstRow) return firstRow - 1;
  var vals = sheet.getRange(firstRow, 1, sheet.getLastRow() - firstRow + 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]).trim() !== '') return firstRow + i;
  }
  return firstRow - 1;
}

/** mobile -> desktop for the same batch, then on to the next batch. */
function adsDfsAdvance_(job, device, batchIdx) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(adsDfsKey_(job, 'Offset'), '0');
  if (device === 'mobile') {
    props.setProperty(adsDfsKey_(job, 'Device'), 'desktop');
  } else {
    props.setProperty(adsDfsKey_(job, 'Device'), 'mobile');
    props.setProperty(adsDfsKey_(job, 'BatchIndex'), String(batchIdx + 1));
  }
}


// ==========================================================
// FETCH ONE BATCH
// ==========================================================

function getAdsDfsBatch_(job, device, startRow, endRow, clearSheet, offset, executionStart, clock, firstInStep) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var inputSheet = adsDfsKeywordSheet_(job);

  var outName = ADS_DFS.jobs[job].outputSheets[device];
  var outSheet = ss.getSheetByName(outName) || ss.insertSheet(outName);
  var lock = LockService.getScriptLock();
  var props = PropertiesService.getScriptProperties();

  if (clearSheet) adsDfsWrite_(lock, outSheet, [ADS_DFS_HEADER], true);

  var keywords = inputSheet.getRange(startRow, 1, endRow - startRow + 1, 1).getValues()
                           .map(function (r) { return String(r[0] || '').trim(); });
  var headers = adsDfsHeaders_();
  var pos = offset;

  while (pos < keywords.length) {
    var chunk = keywords.slice(pos, pos + Math.max(1, ADS_DFS.jobs[job].parallelRequests));
    // The first group of every step always finishes, so a very slow API can't stall the run
    var rows = adsDfsFetchChunk_(chunk, device, headers, clock, firstInStep && pos === offset,
                                 ADS_DFS.jobs[job].samplesPerKeyword);
    if (rows === null) {
      // Out of time part-way through this group: nothing written, the group is redone next step
      console.log('⏱ Time limit reached at keyword ' + pos + '/' + keywords.length + '. Continuing in the next step.');
      return { complete: false, nextOffset: pos };
    }
    if (rows.length) adsDfsWrite_(lock, outSheet, rows, false);
    pos += chunk.length;
    props.setProperty(adsDfsKey_(job, 'Offset'), String(pos));   // progress survives a killed execution
    props.setProperty(adsDfsKey_(job, 'LastProgress'), new Date().toISOString());
    console.log(ADS_DFS.jobs[job].label + ' ' + device + ': ' + pos + '/' + keywords.length +
                ' keywords done (rows ' + startRow + '-' + endRow + ')');
  }

  console.log('✓ ' + device + ' rows ' + startRow + '-' + endRow + ' done in ' +
             ((new Date() - executionStart) / 1000).toFixed(1) + 's');
  return { complete: true, nextOffset: 0 };
}

/**
 * Looks at each keyword in the chunk `samples` times (the looks for one keyword are
 * sequential, a few seconds apart) and returns the combined sheet rows.
 * If there isn't time left in this step it returns null and the group is redone in the next
 * step - unless mustFinish is set (first group of a step, so every step makes progress), in
 * which case looks that couldn't run count as failed looks and can never become 'No Ads Found'.
 */
function adsDfsFetchChunk_(chunk, device, headers, clock, mustFinish, samples) {
  var looks = chunk.map(function () { return []; });
  for (var n = 0; n < samples; n++) {
    var once = adsDfsFetchOnce_(chunk, device, headers, clock, mustFinish);
    if (once === null) {
      if (!mustFinish) return null;
      once = chunk.map(function () { return { retry: true, reason: ADS_DFS_NET_ERR }; });
    }
    once.forEach(function (r, i) { if (r) looks[i].push(r); });
  }
  var rows = [];
  chunk.forEach(function (kw, i) {
    if (!kw) return;
    adsDfsCombine_(kw, looks[i], device).forEach(function (row) { rows.push(row); });
  });
  return rows;
}

/**
 * One look at every keyword in the chunk, in parallel, with retries. Returns parsed results.
 * Returns null if there wasn't time to start the first round of calls (or a needed retry,
 * unless mustFinish - then keywords still failing are returned as failed).
 */
function adsDfsFetchOnce_(chunk, device, headers, clock, mustFinish) {
  var results = new Array(chunk.length);
  var pending = [];
  chunk.forEach(function (kw, i) { if (kw) pending.push(i); });

  for (var attempt = 0; attempt <= ADS_DFS.maxRequestRetries && pending.length; attempt++) {
    if (attempt > 0) Utilities.sleep(ADS_DFS.rate429DelayMs);
    if (clock && !clock.canStart()) {
      if (attempt === 0 || !mustFinish) return null;
      break;
    }

    var requests = pending.map(function (i) { return adsDfsRequest_(chunk[i], device, headers); });
    var responses;
    var t0 = Date.now();
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      console.log('Fetch failed: ' + e.message);
      pending.forEach(function (i) { results[i] = { retry: true, reason: ADS_DFS_NET_ERR }; });
      continue;
    } finally {
      if (clock) clock.record(Date.now() - t0);
    }

    var stillPending = [];
    responses.forEach(function (resp, j) {
      var i = pending[j];
      results[i] = adsDfsParseResponse_(chunk[i], resp.getResponseCode(), resp.getContentText(), adsDfsNow_());
      if (results[i].retry) stillPending.push(i);
    });
    pending = stillPending;
  }
  return results;
}

/**
 * Time budget for one step. A round of calls may only start if, taking as long as the slowest
 * round so far (at least minCallMs), it would still end before executionLimitMs.
 */
function adsDfsClock_(startMs) {
  var slowest = ADS_DFS.minCallMs;
  return {
    canStart: function () { return Date.now() + slowest < startMs + ADS_DFS.executionLimitMs; },
    record: function (ms) { if (ms > slowest) slowest = ms; }
  };
}

/**
 * Pure function. Merges the looks for one keyword into sheet rows:
 *   - every ad seen in any successful look (one row per ad type + advertiser, best position)
 *   - otherwise 'No Ads Found' if every look succeeded
 *   - otherwise an error row, so a failed look can never be read as 0 competitors
 */
function adsDfsCombine_(keyword, looks, device) {
  var ok = looks.filter(function (r) { return r && !r.retry && !r.error; });
  var best = {};
  ok.forEach(function (r) {
    r.rows.forEach(function (row) {
      if (!row[2]) return;                                  // the 'No Ads Found' row
      var key = row[2] + '|' + adsDfsHost_(row[5] || row[6]);
      if (!best[key] || row[3] < best[key][3]) best[key] = row;
    });
  });
  var ads = Object.keys(best).map(function (k) { return best[k]; });
  if (ads.length) {
    return ads.sort(function (a, b) {
      return a[2] === b[2] ? a[3] - b[3] : (a[2] === 'top_ads' ? -1 : 1);
    });
  }
  if (looks.length && ok.length === looks.length) {
    return [ok[0].rows[0]];                                 // 'No Ads Found'
  }
  var failed = looks.filter(function (r) { return !r || r.retry || r.error; })[0] || {};
  var reason = failed.retry ? failed.reason : (failed.rows ? failed.rows[0][4] : ADS_DFS_NET_ERR);
  console.log('✗ "' + keyword + '" (' + device + '): ' + reason);
  return [[adsDfsNow_(), keyword, '', '', reason || ADS_DFS_NET_ERR, '', '', '']];
}

/** Host of a URL or displayed link, lowercase, without www. */
function adsDfsHost_(s) {
  var m = String(s || '').trim().toLowerCase().match(/^(?:[a-z]+:\/\/)?([^\/\s›?#:]+)/);
  return m ? m[1].replace(/^www\./, '') : '';
}

function adsDfsNow_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

/** One live task per request - DataForSEO allows only one task per live call. */
function adsDfsRequest_(keyword, device, headers) {
  return {
    url: ADS_DFS.liveUrl,
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: headers,
    payload: JSON.stringify([{
      keyword       : keyword,
      location_code : ADS_DFS.locationCode,
      language_code : ADS_DFS.languageCode,
      device        : device,
      se_domain     : ADS_DFS.seDomain,
      depth         : ADS_DFS.depth
    }])
  };
}

/**
 * Diagnostic: looks at ADS_DFS.testKeyword exactly as a run would (the high-priority job's samplesPerKeyword looks per
 * device), logs what DataForSEO returned for each look, then the rows that would be written.
 * Writes nothing.
 */
function testAdsDfsKeyword() {
  var headers = adsDfsHeaders_();
  var kw = ADS_DFS.testKeyword;
  console.log('Keyword: "' + kw + '" | location_code ' + ADS_DFS.locationCode);
  ['mobile', 'desktop'].forEach(function (device) {
    var looks = [];
    for (var n = 1; n <= ADS_DFS.jobs.priority.samplesPerKeyword; n++) {
      var resp = UrlFetchApp.fetchAll([adsDfsRequest_(kw, device, headers)])[0];
      var body = resp.getContentText();
      var info = '';
      try {
        var task = JSON.parse(body).tasks[0];
        var res = task.result && task.result[0];
        info = 'status ' + task.status_code + ' | types: ' + (res ? (res.item_types || []).join(',') : '-') +
               ' | check_url: ' + (res ? res.check_url : '-');
      } catch (e) { info = 'unparseable response: ' + body.slice(0, 200); }
      var parsed = adsDfsParseResponse_(kw, resp.getResponseCode(), body, adsDfsNow_());
      looks.push(parsed);
      var ads = parsed.rows ? parsed.rows.filter(function (r) { return r[2]; }) : [];
      console.log('--- ' + device + ' look ' + n + ': ' +
                 (ads.length ? ads.map(function (r) { return adsDfsHost_(r[5]); }).join(', ')
                             : (parsed.retry ? parsed.reason : parsed.rows[0][4])));
      console.log('    ' + info);
    }
    var rows = adsDfsCombine_(kw, looks, device);
    console.log('=== ' + device + ' WRITES ' + rows.length + ' row(s):');
    rows.forEach(function (r) { console.log('    ' + r.slice(2, 6).join(' | ')); });
  });
}

// DataForSEO status codes worth retrying (docs: appendix/errors)
//   40101 search engine error, 40103 task failed - resubmit, 40202 rate limit per minute,
//   40209 too many simultaneous requests, 5xxxx internal / timeout / service unavailable
var ADS_DFS_RETRY_CODES = [40101, 40103, 40202, 40209];

/**
 * Pure function (no Apps Script services). One row per paid ad, like Zenserp:
 * Ad Type is top_ads or bottom_ads (bottom = after the first organic result).
 * Returns {rows:[...]} or {retry:true, reason} for a transient failure.
 * DataForSEO returns HTTP 200 for almost everything; the real status is status_code
 * at the top level and on each task.
 */
function adsDfsParseResponse_(keyword, httpCode, bodyText, ts) {
  var errRow = function (text) { return { error: true, rows: [[ts, keyword, '', '', text, '', '', '']] }; };

  if (httpCode === 429) return { retry: true, reason: ADS_DFS_429 };
  if (httpCode >= 500)  return { retry: true, reason: 'HTTP ' + httpCode };

  var data;
  try { data = JSON.parse(bodyText); }
  catch (e) { return httpCode === 200 ? { retry: true, reason: ADS_DFS_NET_ERR } : errRow('HTTP ' + httpCode); }

  // Top-level status (e.g. 40100 bad login, 40200 / 40210 no balance, 40203 daily cost limit hit)
  var top = data && data.status_code;
  var task = data && data.tasks && data.tasks[0];
  var code = (top && top !== 20000) ? top : (task ? task.status_code : null);
  var msg  = (top && top !== 20000) ? data.status_message : (task ? task.status_message : '');

  if (code === null) return { retry: true, reason: ADS_DFS_NET_ERR };
  if (code !== 20000) {
    var text = 'API error ' + code + (msg ? ': ' + msg : '');
    if (code === 40202 || code === 40209) return { retry: true, reason: ADS_DFS_429 };
    if (code >= 50000 || ADS_DFS_RETRY_CODES.indexOf(code) !== -1) return { retry: true, reason: text };
    return errRow(text);   // e.g. bad login, no funds, cost limit, invalid field - retrying won't help
  }

  var result = task.result && task.result[0];
  var items = (result && Array.isArray(result.items)) ? result.items : null;
  // No result or an empty page is a failed fetch, not "no ads"
  if (!items || items.length === 0) return { retry: true, reason: ADS_DFS_NET_ERR };

  var firstOrganic = Infinity;
  items.forEach(function (it) {
    if (it && it.type === 'organic' && it.rank_absolute < firstOrganic) firstOrganic = it.rank_absolute;
  });

  var counts = { top_ads: 0, bottom_ads: 0 };
  var rows = [];
  items.forEach(function (ad) {
    if (!ad || ad.type !== 'paid') return;
    var block = ad.rank_absolute > firstOrganic ? 'bottom_ads' : 'top_ads';
    counts[block]++;
    rows.push([
      ts, keyword, block, counts[block],
      ad.title || '',
      ad.breadcrumb || ad.domain || '',
      ad.url || '',
      ad.description || ''
    ]);
  });

  if (!rows.length) rows.push([ts, keyword, '', '', ADS_DFS_NO_ADS, '', '', '']);
  return { rows: rows };
}

function adsDfsHeaders_() {
  var props = PropertiesService.getScriptProperties();
  var login = props.getProperty('DFS_LOGIN')    || DFS_LOGIN;
  var pass  = props.getProperty('DFS_PASSWORD') || DFS_PASSWORD;
  return { 'Authorization': 'Basic ' + Utilities.base64Encode(login + ':' + pass) };
}

function adsDfsWrite_(lock, sheet, rows, clear) {
  var got = false;
  try {
    got = lock.tryLock(ADS_DFS.lockTimeoutMs);
    if (!got) throw new Error('Could not acquire sheet lock');
    if (clear) {
      sheet.clear();
      sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    } else if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    }
  } finally {
    if (got) lock.releaseLock();
  }
}


// ==========================================================
// TEST ONLY: compare the DFS tabs with the Zen tabs
// ==========================================================

/** Full run: compares AdsResultsZen* with AdsResultsDFS* for every keyword. */
function compareAdsParity() {
  adsDfsCompare_('full', 'Parity Check',
                 { mobile: 'AdsResultsZenMobile', desktop: 'AdsResultsZenDesktop' });
}

/** High-priority run: compares the _HighPriority tabs for rows 2-201. */
function compareAdsParityPriority() {
  adsDfsCompare_('priority', 'Parity Check HighPriority',
                 { mobile: 'AdsResultsZenMobile_HighPriority', desktop: 'AdsResultsZenDesktop_HighPriority' });
}

/**
 * Writes a parity tab: per keyword, the number of non-Trade Me ads Zenserp and DataForSEO
 * each found (mobile, desktop) and the latest timestamp on each side.
 */
function adsDfsCompare_(job, tabName, zenTabs) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = ADS_DFS.jobs[job];
  var kwSheet = ss.getSheetByName(ADS_DFS.inputSheetName);
  var last = Math.min(cfg.lastRow, adsDfsLastRow_(kwSheet, cfg.firstRow));
  var keywords = last < cfg.firstRow ? [] :
    kwSheet.getRange(cfg.firstRow, 1, last - cfg.firstRow + 1, 1).getValues()
           .map(function (r) { return String(r[0] || '').trim(); }).filter(String);

  var zm = adsDfsCount_(ss.getSheetByName(zenTabs.mobile));
  var dm = adsDfsCount_(ss.getSheetByName(cfg.outputSheets.mobile));
  var zd = adsDfsCount_(ss.getSheetByName(zenTabs.desktop));
  var dd = adsDfsCount_(ss.getSheetByName(cfg.outputSheets.desktop));

  var out = [['Keyword', 'Zen mobile', 'DFS mobile', 'Zen desktop', 'DFS desktop',
              'Zen last run', 'DFS last run', 'Match (0 vs >0)']];
  var match = 0, diff = 0;
  keywords.forEach(function (kw) {
    var v = [zm[kw], dm[kw], zd[kw], dd[kw]].map(function (x) { return x ? x.n : 'n/a'; });
    var same = (v[0] > 0) === (v[1] > 0) && (v[2] > 0) === (v[3] > 0);
    if (same) match++; else diff++;
    out.push([kw, v[0], v[1], v[2], v[3],
              (zm[kw] || zd[kw] || {}).ts || '', (dm[kw] || dd[kw] || {}).ts || '',
              same ? 'yes' : 'NO']);
  });

  var sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
  sheet.clear();
  sheet.getRange(1, 1, out.length, out[0].length).setValues(out);
  sheet.setFrozenRows(1);
  console.log(tabName + ': ' + match + ' match, ' + diff + ' differ, of ' + keywords.length);
}

/** keyword -> {n: ads not on trademe.co.nz, ts: latest timestamp} */
function adsDfsCount_(sheet) {
  var map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues().forEach(function (r) {
    var kw = String(r[1] || '').trim();
    if (!kw) return;
    var e = map[kw] || (map[kw] = { n: 0, ts: '' });
    var ts = r[0] instanceof Date ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : String(r[0]);
    if (ts > e.ts) e.ts = ts;
    if (!r[2]) return;   // No Ads Found / error rows have no Ad Type
    if (!/trademe\.co\.nz/i.test(String(r[5]) + ' ' + String(r[6]))) e.n++;
  });
  return map;
}


// ==========================================================
// STATUS
// ==========================================================

function checkAdsDfsStatus() {
  var props = PropertiesService.getScriptProperties();
  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  console.log('================ DFS ADS STATUS ================');
  Object.keys(ADS_DFS.jobs).forEach(function (job) {
    var cfg = ADS_DFS.jobs[job];
    console.log('--- ' + cfg.label + ' (' + cfg.outputSheets.mobile + ' / ' + cfg.outputSheets.desktop + ')');
    console.log('Running: ' + (props.getProperty(adsDfsKey_(job, 'Running')) === 'true' ? 'YES' : 'NO'));
    ['Device', 'BatchIndex', 'Offset', 'StartTime', 'LastProgress', 'LastBatch', 'LastBatchTime', 'CompletedAt', 'StoppedReason',
     'StartupFailure', 'TriggerFailed', 'WatchdogResumed'].forEach(function (n) {
      var v = props.getProperty(adsDfsKey_(job, n));
      if (v) console.log(n + ': ' + v);
    });
    var running = props.getProperty(adsDfsKey_(job, 'Running')) === 'true';
    var waiting = handlers.filter(function (h) { return h === ADS_DFS_HANDLERS[job].run; }).length;
    console.log('Step trigger present: ' + (waiting ? 'yes' : 'no'));
    if (running) {
      var last = new Date(props.getProperty(adsDfsKey_(job, 'LastProgress')) || '');
      var mins = isNaN(last.getTime()) ? null : Math.round((new Date() - last) / 60000);
      console.log('Last progress: ' + (mins === null ? 'unknown' : mins + ' min ago') +
        (mins === null || mins >= ADS_DFS.stallMinutes
          ? '  <- run is stalled: the hourly watchdog will continue it, or run ' + (job === 'full' ? 'resumeAdsDfsFullNow()' : 'resumeAdsDfsPriorityNow()')
          : ''));
    }
    console.log('Daily starters: ' + handlers.filter(function (h) { return h === ADS_DFS_HANDLERS[job].start; }).length +
                ' (expected ' + cfg.hours.length + ')');
  });
}
