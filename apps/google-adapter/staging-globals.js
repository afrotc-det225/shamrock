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

function shamrockV3StagingFrontend_() {
  return SHAMROCKV3.createNativeFrontendRuntime({
    PropertiesService: PropertiesService,
    Utilities: Utilities,
    UrlFetchApp: UrlFetchApp,
    ScriptApp: ScriptApp,
    Session: Session,
    LockService: LockService
  });
}

function shamrockV3StagingMaintenance_() {
  return SHAMROCKV3.createNativeMaintenanceRuntime({
    PropertiesService: PropertiesService, Utilities: Utilities, UrlFetchApp: UrlFetchApp,
    ScriptApp: ScriptApp, Session: Session, LockService: LockService
  });
}
function shamrockV3StagingMaintenancePause() { return shamrockV3StagingMaintenance_().pause(); }
function shamrockV3StagingMaintenanceResume() { return shamrockV3StagingMaintenance_().resume(); }
function shamrockV3StagingNotificationsPlan() { return shamrockV3StagingMaintenance_().planNotifications(); }
function shamrockV3StagingTransitionArchive(transitionId) { return shamrockV3StagingMaintenance_().archive(transitionId); }
function shamrockV3StagingTransitionCommand(input) { return shamrockV3StagingMaintenance_().command(input); }

function shamrockV3StagingSetup() {
  var host = shamrockV3StagingHost_();
  shamrockV3StagingPauseBoth_(host);
  host.initializeProjections();
  host.repairPresentation();
  return host.setup();
}

function shamrockV3StagingPauseBoth_(host) {
  var result;
  var failure;
  try { result = host.pause(); } catch (error) { failure = error; }
  try { shamrockV3StagingFrontend_().pause(); } catch (error) { if (!failure) failure = error; }
  try { shamrockV3StagingMaintenance_().pause(); } catch (error) { if (!failure) failure = error; }
  if (failure) throw failure;
  return result;
}

function shamrockV3StagingPause() {
  return shamrockV3StagingPauseBoth_(shamrockV3StagingHost_());
}
function shamrockV3StagingRepairPresentation() { return shamrockV3StagingHost_().repairPresentation(); }
function shamrockV3StagingImportConfig() {
  return SHAMROCKV3.importStagingConfiguration({
    PropertiesService: PropertiesService,
    UrlFetchApp: UrlFetchApp,
    ScriptApp: ScriptApp,
    Session: Session
  });
}
function shamrockV3StagingResume() { return shamrockV3StagingHost_().resume(); }
function shamrockV3StagingFlush() {
  var intake = shamrockV3StagingHost_().flush();
  // Frontend maintenance has a separate explicit gate; Forms may remain paused.
  var frontend = shamrockV3StagingFrontend_().refresh();
  var maintenance = shamrockV3StagingMaintenance_().planNotifications();
  return Object.assign({}, intake, { frontend: frontend, maintenance: maintenance });
}
function shamrockV3StagingFrontendRefresh() { return shamrockV3StagingFrontend_().refresh(); }
function shamrockV3StagingFrontendPause() { return shamrockV3StagingFrontend_().pause(); }
function shamrockV3StagingFrontendResume() { return shamrockV3StagingFrontend_().resume(); }
function shamrockV3StagingAttendanceSubmit(e) { return shamrockV3StagingHost_().onAttendanceSubmit(e); }
function shamrockV3StagingExcusalSubmit(e) { return shamrockV3StagingHost_().onExcusalSubmit(e); }
function shamrockV3StagingDecisionEdit(e) { return shamrockV3StagingHost_().onDecisionEdit(e); }
