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
function shamrockV3StagingForms_() {
  return SHAMROCKV3.createNativeFormsRuntime({ PropertiesService: PropertiesService, Utilities: Utilities,
    UrlFetchApp: UrlFetchApp, ScriptApp: ScriptApp, Session: Session, FormApp: FormApp, LockService: LockService });
}

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
  try { if (typeof SHAMROCKV3 !== 'undefined' && SHAMROCKV3.createNativeFormsRuntime) shamrockV3StagingForms_().pause(); } catch (error) { if (!failure) failure = error; }
  try { if (typeof SHAMROCKV3 !== 'undefined' && SHAMROCKV3.createNativeFrontendInput) shamrockV3NativeInput_().pause(); } catch (error) { if (!failure) failure = error; }
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
  var result = Object.assign({}, intake, { frontend: frontend, maintenance: maintenance });
  if (typeof SHAMROCKV3 !== 'undefined' && SHAMROCKV3.createNativeFormsRuntime) {
    var forms = shamrockV3StagingForms_();
    result.formIntake = forms.flush(); result.forms = forms.refresh();
  }
  if (typeof SHAMROCKV3 !== 'undefined' && SHAMROCKV3.createNativeFrontendInput) result.nativeInput = shamrockV3NativeInput_().flush();
  return result;
}
function shamrockV3StagingFrontendRefresh() { return shamrockV3StagingFrontend_().refresh(); }
function shamrockV3StagingFrontendPause() { return shamrockV3StagingFrontend_().pause(); }
function shamrockV3StagingFrontendResume() { return shamrockV3StagingFrontend_().resume(); }
function shamrockV3StagingAttendanceSubmit(e) { return shamrockV3StagingHost_().onAttendanceSubmit(e); }
function shamrockV3StagingExcusalSubmit(e) { return shamrockV3StagingHost_().onExcusalSubmit(e); }
function shamrockV3StagingDecisionEdit(e) { return shamrockV3StagingHost_().onDecisionEdit(e); }

function shamrockV3ManagedFormsSetup() { return shamrockV3StagingForms_().setup(); }
function shamrockV3ManagedFormsRefresh() { return shamrockV3StagingForms_().refresh(); }
function shamrockV3ManagedFormsPause() { return shamrockV3StagingForms_().pause(); }
function shamrockV3ManagedFormsResume() { return shamrockV3StagingForms_().resumePublication(); }
function shamrockV3ManagedIntakeResume() { return shamrockV3StagingForms_().resumeIntake(); }
function shamrockV3ManagedFormsStatus() { return shamrockV3StagingForms_().status(); }
function shamrockV3ManagedDirectoryReviewQueue() { return shamrockV3StagingForms_().directoryReviewQueue(); }
function shamrockV3ManagedDirectoryReview(input) { return shamrockV3StagingForms_().reviewDirectory(input); }
function shamrockV3ManagedAttendanceSubmit(e) { return shamrockV3StagingForms_().submit('attendance', e); }
function shamrockV3ManagedExcusalSubmit(e) { return shamrockV3StagingForms_().submit('excusals', e); }
function shamrockV3ManagedDirectorySubmit(e) { return shamrockV3StagingForms_().submit('directory', e); }

function shamrockV3ManagedFormReplay(key, responseId) { return shamrockV3StagingForms_().replay(key, responseId); }

function shamrockV3NativeInput_() { return SHAMROCKV3.createNativeFrontendInput({ PropertiesService: PropertiesService, Utilities: Utilities,
  UrlFetchApp: UrlFetchApp, ScriptApp: ScriptApp, Session: Session, FormApp: FormApp, LockService: LockService }); }
function shamrockV3NativeInputSetup() { return shamrockV3NativeInput_().setup(); }
function shamrockV3NativeInputPause() { return shamrockV3NativeInput_().pause(); }
function shamrockV3NativeInputResume() { return shamrockV3NativeInput_().resume(); }
function shamrockV3NativeInputFlush() { return shamrockV3NativeInput_().flush(); }
function shamrockV3NativeInputStatus() { return shamrockV3NativeInput_().status(); }
function shamrockV3NativeFrontendEdit(e) { return shamrockV3NativeInput_().onEdit(e); }
function shamrockV3NativeFrontendConfirm(e) { return shamrockV3NativeInput_().confirm(e); }
function shamrockV3NativeConfirmationReplay(responseId) { return shamrockV3NativeInput_().replayConfirmation(responseId); }

function shamrockV3NativeInputReviewQueue() { return shamrockV3NativeInput_().reviewQueue(); }
