// Apps Script discovers top-level function declarations, not IIFE object methods.
// Keep these entry points separate from the current production script and menus.
function shamrockV3StagingHost_() {
  return SHAMROCKV3.createNativeStagingHost({
    PropertiesService: PropertiesService,
    Utilities: Utilities,
    UrlFetchApp: UrlFetchApp,
    ScriptApp: ScriptApp,
    Session: Session,
    FormApp: FormApp,
    SpreadsheetApp: SpreadsheetApp,
    LockService: LockService
  });
}

function shamrockV3StagingSetup() {
  var host = shamrockV3StagingHost_();
  host.pause();
  host.initializeProjections();
  return host.setup();
}

function shamrockV3StagingPause() { return shamrockV3StagingHost_().pause(); }
function shamrockV3StagingImportConfig() {
  return SHAMROCKV3.importStagingConfiguration({
    PropertiesService: PropertiesService,
    UrlFetchApp: UrlFetchApp,
    ScriptApp: ScriptApp,
    Session: Session
  });
}
function shamrockV3StagingResume() { return shamrockV3StagingHost_().resume(); }
function shamrockV3StagingFlush() { return shamrockV3StagingHost_().flush(); }
function shamrockV3StagingAttendanceSubmit(e) { return shamrockV3StagingHost_().onAttendanceSubmit(e); }
function shamrockV3StagingExcusalSubmit(e) { return shamrockV3StagingHost_().onExcusalSubmit(e); }
function shamrockV3StagingDecisionEdit(e) { return shamrockV3StagingHost_().onDecisionEdit(e); }
