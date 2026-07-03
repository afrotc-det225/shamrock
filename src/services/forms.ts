// Form builders to scaffold required questions. Idempotent: only seeds when the form is empty.

namespace FormService {
  function clearItems(form: GoogleAppsScript.Forms.Form) {
    const items = form.getItems();

    // First, strip navigation from choice items so page break dependencies don't block deletion.
    items.forEach((item) => {
      const type = item.getType && item.getType();
      if (type === FormApp.ItemType.MULTIPLE_CHOICE || type === FormApp.ItemType.LIST) {
        try {
          const mc = (type === FormApp.ItemType.MULTIPLE_CHOICE ? item.asMultipleChoiceItem?.() : item.asListItem?.()) as any;
          if (!mc) return;
          const choices = mc.getChoices().map((c: GoogleAppsScript.Forms.Choice) => mc.createChoice(c.getValue()));
          mc.setChoices(choices);
        } catch (err) {
          Log.warn(`Unable to strip navigation from item '${item.getTitle?.() || ''}': ${err}`);
        }
      }
    });

    for (let i = form.getItems().length - 1; i >= 0; i--) {
      const currentItems = form.getItems();
      const item = currentItems[i];
      const title = (item?.getTitle && item.getTitle()) || '';
      try {
        form.deleteItem(i);
      } catch (err) {
        Log.warn(`Unable to delete form item '${title}': ${err}`);
      }
    }
  }

  function removeItemsByTitle(form: GoogleAppsScript.Forms.Form, titles: string[]) {
    const titleSet = new Set(titles.map((t) => t.toLowerCase()));
    for (let i = form.getItems().length - 1; i >= 0; i--) {
      const item = form.getItems()[i];
      const t = (item?.getTitle && item.getTitle()) || '';
      if (titleSet.has(String(t).toLowerCase())) {
        try {
          form.deleteItem(i);
          Log.info(`Removed redundant form item titled '${t}'`);
        } catch (err) {
          Log.warn(`Unable to remove item titled '${t}'. Error: ${err}`);
        }
      }
    }
  }

  function seedIfEmpty(form: GoogleAppsScript.Forms.Form, builder: (f: GoogleAppsScript.Forms.Form) => void, label: string) {
    if (form.getItems().length === 0) {
      Log.info(`Seeding form items for ${label}`);
      builder(form);
    } else {
      Log.info(`Form ${label} already has items; not modifying questions.`);
    }
  }

  function withFormRetry<T>(
    form: GoogleAppsScript.Forms.Form,
    label: string,
    action: (f: GoogleAppsScript.Forms.Form) => T,
  ): { form: GoogleAppsScript.Forms.Form; result: T } {
    let working = form;
    let lastErr: any;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return { form: working, result: action(working) };
      } catch (err) {
        lastErr = err;
        Log.warn(`Attendance form: ${label} failed (attempt ${attempt}): ${err}`);
        Utilities.sleep(400 * attempt);
        try {
          working = FormApp.openById(working.getId());
        } catch (reopenErr) {
          Log.warn(`Attendance form: unable to reopen form after failure: ${reopenErr}`);
        }
      }
    }
    throw lastErr;
  }

  function addPageBreakItemSafe(
    form: GoogleAppsScript.Forms.Form,
    title: string,
    goTo: GoogleAppsScript.Forms.PageNavigationType,
  ): { form: GoogleAppsScript.Forms.Form; item: GoogleAppsScript.Forms.PageBreakItem } {
    const { form: nextForm, result } = withFormRetry(form, `addPageBreakItem ${title}`, (f) => {
      const result = f.addPageBreakItem();
      result.setTitle(title);
      result.setGoToPage(goTo);
      if (String(result.getTitle() || '').trim() !== title) throw new Error(`Page break title mismatch after setTitle("${title}")`);
      return result;
    });
    return { form: nextForm, item: result };
  }

  function addTextItemSafe(
    form: GoogleAppsScript.Forms.Form,
    title: string,
    required = false,
  ): { form: GoogleAppsScript.Forms.Form; item: GoogleAppsScript.Forms.TextItem } {
    const { form: nextForm, result } = withFormRetry(form, `addTextItem ${title}`, (f) => {
      const result = f.addTextItem();
      result.setTitle(title);
      if (required) result.setRequired(true);
      if (String(result.getTitle() || '').trim() !== title) throw new Error(`Text item title mismatch after setTitle("${title}")`);
      return result;
    });
    return { form: nextForm, item: result };
  }

  function addListItemSafe(
    form: GoogleAppsScript.Forms.Form,
    title: string,
    choices?: string[],
    required = false,
  ): { form: GoogleAppsScript.Forms.Form; item: GoogleAppsScript.Forms.ListItem } {
    const { form: nextForm, result } = withFormRetry(form, `addListItem ${title}`, (f) => {
      const result = f.addListItem();
      result.setTitle(title);
      if (choices && choices.length) result.setChoiceValues(choices);
      if (required) result.setRequired(true);
      if (String(result.getTitle() || '').trim() !== title) throw new Error(`List item title mismatch after setTitle("${title}")`);
      return result;
    });
    return { form: nextForm, item: result };
  }

  function addMultipleChoiceItemSafe(
    form: GoogleAppsScript.Forms.Form,
    title: string,
    required = false,
  ): { form: GoogleAppsScript.Forms.Form; item: GoogleAppsScript.Forms.MultipleChoiceItem } {
    const { form: nextForm, result } = withFormRetry(form, `addMultipleChoiceItem ${title}`, (f) => {
      const result = f.addMultipleChoiceItem();
      result.setTitle(title);
      if (required) result.setRequired(true);
      if (String(result.getTitle() || '').trim() !== title) throw new Error(`Multiple choice title mismatch after setTitle("${title}")`);
      return result;
    });
    return { form: nextForm, item: result };
  }

  function addCheckboxItemSafe(
    form: GoogleAppsScript.Forms.Form,
    title: string,
    choices: string[],
  ): { form: GoogleAppsScript.Forms.Form; item: GoogleAppsScript.Forms.CheckboxItem } {
    const { form: nextForm, result } = withFormRetry(form, `addCheckboxItem ${title}`, (f) => {
      const result = f.addCheckboxItem();
      result.setTitle(title);
      if (choices.length > 0) {
        result.setChoiceValues(choices);
      }
      if (String(result.getTitle() || '').trim() !== title) throw new Error(`Checkbox item title mismatch after setTitle("${title}")`);
      return result;
    });
    return { form: nextForm, item: result };
  }

  function findPageBreakItem(form: GoogleAppsScript.Forms.Form, title: string): GoogleAppsScript.Forms.PageBreakItem | null {
    const match = form.getItems(FormApp.ItemType.PAGE_BREAK).find((item) => {
      try {
        return String(item.getTitle() || '').trim() === title;
      } catch {
        return false;
      }
    });
    return match ? match.asPageBreakItem() : null;
  }

  function findListItem(form: GoogleAppsScript.Forms.Form, title: string): GoogleAppsScript.Forms.ListItem | null {
    const match = form.getItems(FormApp.ItemType.LIST).find((item) => {
      try {
        return String(item.getTitle() || '').trim() === title;
      } catch {
        return false;
      }
    });
    return match ? match.asListItem() : null;
  }

  function findMultipleChoiceItem(form: GoogleAppsScript.Forms.Form, title: string): GoogleAppsScript.Forms.MultipleChoiceItem | null {
    const match = form.getItems(FormApp.ItemType.MULTIPLE_CHOICE).find((item) => {
      try {
        return String(item.getTitle() || '').trim() === title;
      } catch {
        return false;
      }
    });
    return match ? match.asMultipleChoiceItem() : null;
  }

  function countDefaultQuestionTitles(form: GoogleAppsScript.Forms.Form): number {
    return form.getItems().filter((item) => {
      try {
        const type = item.getType && item.getType();
        if (
          type !== FormApp.ItemType.TEXT &&
          type !== FormApp.ItemType.PARAGRAPH_TEXT &&
          type !== FormApp.ItemType.LIST &&
          type !== FormApp.ItemType.MULTIPLE_CHOICE &&
          type !== FormApp.ItemType.CHECKBOX
        ) {
          return false;
        }
        return String(item.getTitle() || '').trim().toLowerCase() === 'question';
      } catch {
        return false;
      }
    }).length;
  }

  function readAttendanceEventBuckets(): {
    mando: string[];
    llab: string[];
    poc: string[];
    secondary: string[];
    other: string[];
  } {
    const buckets = { mando: [] as string[], llab: [] as string[], poc: [] as string[], secondary: [] as string[], other: [] as string[] };
    try {
      const backendId = Config.getBackendId();
      const eventsSheet = backendId ? SheetUtils.getSheet(backendId, 'Events Backend') : null;
      if (!eventsSheet) return buckets;

      const eventsTable = SheetUtils.readTable(eventsSheet);
      eventsTable.rows.forEach((r) => {
        const name = String(r['display_name'] || r['attendance_column_label'] || r['event_id'] || '').trim();
        if (!name) return;
        const type = String(r['event_type'] || '').toLowerCase();
        const expectedGroup = String(r['expected_group'] || '').toLowerCase();
        const nameLc = name.toLowerCase();

        if (type.includes('llab')) buckets.llab.push(name);
        else if (type.includes('mando')) buckets.mando.push(name);
        else if (type.includes('secondary')) buckets.secondary.push(name);
        else if (expectedGroup.includes('poc') || type.includes('third hour') || nameLc.includes('poc third hour')) buckets.poc.push(name);
        else buckets.other.push(name);
      });
    } catch (err) {
      Log.warn(`Unable to read attendance events: ${err}`);
    }

    return buckets;
  }

  interface CadetOption {
    label: string;
    asYear: string;
    flight: string;
    university: string;
  }

  interface CadetGroups {
    byFlight: Record<string, Record<string, string[]>>; // flight -> AS -> labels (excludes crosstown for Mando)
    byFlightAll: Record<string, Record<string, string[]>>; // flight -> AS -> labels (includes crosstown for LLAB)
    byCrosstown: Record<string, Record<string, string[]>>; // university -> AS -> labels
    allByAs: Record<string, string[]>; // AS -> labels
    nonAbroadByAs: Record<string, string[]>; // AS -> labels (exclude flight Abroad)
    pocByAs: Record<string, string[]>; // AS -> labels (AS300+ only)
  }

  function normalizeToList(value: string, options: string[]): string {
    const v = String(value || '').trim();
    if (!v) return '';
    const lc = v.toLowerCase();
    const exact = options.find((o) => o.toLowerCase() === lc);
    if (exact) return exact;
    const prefix = options.find((o) => lc.startsWith(o.toLowerCase()));
    if (prefix) return prefix;
    const contains = options.find((o) => lc.includes(o.toLowerCase()));
    if (contains) return contains;
    return '';
  }

  function buildCadetGroups(): CadetGroups {
    const groups: CadetGroups = { byFlight: {}, byFlightAll: {}, byCrosstown: {}, allByAs: {}, nonAbroadByAs: {}, pocByAs: {} };
    try {
      const backendId = Config.getBackendId();
      const sheet = SheetUtils.getSheet(backendId, 'Directory Backend');
      if (!sheet) return groups;
      const table = SheetUtils.readTable(sheet);
      const asYearNumber = (raw: string): number => {
        const match = String(raw || '').toUpperCase().match(/AS\s*(\d+)/);
        if (!match) return 0;
        return Number(match[1] || 0) || 0;
      };
      table.rows.filter((r) => DirectoryService.isOperationallyActiveCadet(r)).forEach((r) => {
        const as = String(r['as_year'] || '').trim() || 'Unknown';
        const flightRaw = String(r['flight'] || '').trim();
        const normalizedFlight = normalizeToList(flightRaw, Arrays.FLIGHTS);
        const flight = normalizedFlight || flightRaw;
        const university = String(r['university'] || '').trim();
        const label = `${r['last_name'] || ''}, ${r['first_name'] || ''}`.trim();

        // all cadets grouped by AS
        groups.allByAs[as] = groups.allByAs[as] || [];
        groups.allByAs[as].push(label);

        const isAbroad = normalizedFlight === 'Abroad' || flightRaw.toLowerCase() === 'abroad';
        if (!isAbroad) {
          groups.nonAbroadByAs[as] = groups.nonAbroadByAs[as] || [];
          groups.nonAbroadByAs[as].push(label);
        }

        // POC Third Hour: AS300+ only, exclude Abroad cadets
        if (asYearNumber(as) >= 300 && !isAbroad) {
          groups.pocByAs[as] = groups.pocByAs[as] || [];
          groups.pocByAs[as].push(label);
        }

        const uniLc = university.toLowerCase().trim();
        // Treat Trine and Valpo/Valparaiso as crosstown regardless of extra words
          const isCrosstown = !isAbroad && (/trine/.test(uniLc) || /valpo|valpar/.test(uniLc));

        if (flight) {
          // Full flight grouping (including crosstown) for LLAB
          groups.byFlightAll[flight] = groups.byFlightAll[flight] || {};
          groups.byFlightAll[flight][as] = groups.byFlightAll[flight][as] || [];
          groups.byFlightAll[flight][as].push(label);

          groups.byFlight[flight] = groups.byFlight[flight] || {};
          groups.byFlight[flight][as] = groups.byFlight[flight][as] || [];
          // Exclude crosstown cadets from byFlight (they go to byCrosstown for Mando)
          if (!isAbroad && !isCrosstown) {
            groups.byFlight[flight][as].push(label);
          }
        }

        // Add crosstown cadets to byCrosstown for Mando branch
        if (isCrosstown) {
          groups.byCrosstown[university] = groups.byCrosstown[university] || {};
          groups.byCrosstown[university][as] = groups.byCrosstown[university][as] || [];
          groups.byCrosstown[university][as].push(label);
        }
      });

      const sortValues = (m: Record<string, string[]>) => {
        Object.keys(m).forEach((k) => m[k].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
      };
      sortValues(groups.allByAs);
      sortValues(groups.nonAbroadByAs);
      sortValues(groups.pocByAs);
      Object.values(groups.byFlight).forEach(sortValues);
      Object.values(groups.byFlightAll).forEach(sortValues);
      Object.values(groups.byCrosstown).forEach(sortValues);
    } catch (err) {
      Log.warn(`Unable to build cadet groups: ${err}`);
    }
    return groups;
  }

  function enforceExcusalsItemOrder(form: GoogleAppsScript.Forms.Form) {
    const desired = ['Last Name', 'First Name', 'Event', 'Reason'];
    const items = form.getItems();
    const findByTitle = (title: string) =>
      items.find((item) => String(item.getTitle?.() || '').trim().toLowerCase() === title.toLowerCase());

    desired.forEach((title, idx) => {
      const item = findByTitle(title);
      if (item) {
        try {
          form.moveItem(item, idx);
        } catch (err) {
          Log.warn(`Unable to move item ${title}: ${err}`);
        }
      }
    });
  }

  function applyDirectoryRegexValidations(form: GoogleAppsScript.Forms.Form) {
    const findTextItem = (title: string): GoogleAppsScript.Forms.TextItem | null => {
      const item = form.getItems(FormApp.ItemType.TEXT).find((i) => String(i.getTitle() || '').trim() === title);
      return item ? item.asTextItem() : null;
    };

    const classYearItem = findTextItem('Class Year (YYYY)');
    if (classYearItem) {
      try {
        const classYearPattern = /^\d{4}$/;
        const validation = FormApp.createTextValidation().setHelpText('Enter a 4-digit year (YYYY)').requireTextMatchesPattern(classYearPattern.source).build();
        classYearItem.setValidation(validation);
      } catch (err) {
        Log.warn(`Unable to apply class year validation on Directory form: ${err}`);
      }
    }

    const cipCodeItem = findTextItem('CIP Code (XX.XXXX)');
    if (cipCodeItem) {
      try {
        const cipPattern = /^\d{2}\.\d{4}$/;
        const validation = FormApp.createTextValidation().setHelpText('Format: 12.3456').requireTextMatchesPattern(cipPattern.source).build();
        cipCodeItem.setValidation(validation);
      } catch (err) {
        Log.warn(`Unable to apply CIP code validation on Directory form: ${err}`);
      }
    }

    const phoneTitles = ['Phone (+5 (555) 555-5555)', 'Phone (+1 (555) 555-5555)'];
    const phoneItem = phoneTitles.reduce<GoogleAppsScript.Forms.TextItem | null>((found, title) => found || findTextItem(title), null);
    if (phoneItem) {
      try {
        const phonePattern = /^\+\d \(\d{3}\) \d{3}-\d{4}$/;
        const validation = FormApp.createTextValidation()
          .setHelpText('Format: +5 (555) 555-5555')
          .requireTextMatchesPattern(phonePattern.source)
          .build();
        phoneItem.setValidation(validation);
      } catch (err) {
        Log.warn(`Unable to apply phone validation on Directory form: ${err}`);
      }
    }

    const photoItem = findTextItem('Photo Link (URL)');
    if (photoItem) {
      try {
        const validation = FormApp.createTextValidation().setHelpText('Enter a valid URL').requireTextIsUrl().build();
        photoItem.setValidation(validation);
      } catch (err) {
        Log.warn(`Unable to apply photo URL validation on Directory form: ${err}`);
      }
    }
  }

  export function ensureDirectoryForm(form: GoogleAppsScript.Forms.Form) {
    // Prune redundant email item; form already collects verified email via settings.
    removeItemsByTitle(form, ['University Email']);

    seedIfEmpty(form, (f) => {
      buildDirectoryForm(f);
    }, 'Directory Form');

    applyDirectoryRegexValidations(form);
  }

  function buildDirectoryForm(f: GoogleAppsScript.Forms.Form) {
    f.addTextItem().setTitle('Last Name').setRequired(true);
    f.addTextItem().setTitle('First Name').setRequired(true);
    f.addListItem().setTitle('Rank').setChoiceValues(Arrays.CADET_RANKS);
    f.addTextItem().setTitle('Role');
    f.addListItem().setTitle('AS Year').setChoiceValues(Arrays.AS_YEARS).setRequired(true);
    f.addTextItem().setTitle('Class Year (YYYY)').setRequired(true);
    f.addListItem().setTitle('Flight').setChoiceValues(Arrays.FLIGHTS);
    f.addListItem().setTitle('Squadron').setChoiceValues(Arrays.SQUADRONS);
    f.addListItem().setTitle('University').setChoiceValues(Arrays.UNIVERSITIES).setRequired(true);
    f.addTextItem().setTitle('Phone (+1 (555) 555-5555)').setRequired(true);
    f.addListItem().setTitle('Dorm').setChoiceValues(Arrays.DORMS);
    f.addTextItem().setTitle('Home Town').setRequired(true);
    f.addListItem().setTitle('Home State').setChoiceValues(Arrays.HOME_STATES).setRequired(true);
    f.addDateItem().setTitle('DOB (MM/DD/YYYY)').setRequired(true);
    f.addListItem().setTitle('CIP Broad Area').setChoiceValues(Arrays.CIP_BROAD_AREAS);
    f.addTextItem().setTitle('CIP Code (XX.XXXX)');
    f.addListItem().setTitle('Desired/Assigned AFSC').setChoiceValues(Arrays.AFSC_OPTIONS);
    f.addListItem().setTitle('Flight Path Status').setChoiceValues(Arrays.FLIGHT_PATH_STATUSES);
    f.addTextItem().setTitle('Photo Link (URL)');
    f.addParagraphTextItem().setTitle('Notes');
  }

  export function rebuildDirectoryForm(form: GoogleAppsScript.Forms.Form) {
    clearItems(form);
    buildDirectoryForm(form);
    applyDirectoryRegexValidations(form);
  }

  export function ensureAttendanceForm(form: GoogleAppsScript.Forms.Form) {
    // If empty, build the full form; otherwise just keep the Event list up to date.
    if (form.getItems().length === 0) {
      rebuildAttendanceForm(form);
      return;
    }

    refreshAttendanceFormEventChoices(form);
  }

  export function rebuildAttendanceForm(form: GoogleAppsScript.Forms.Form) {
    // Rebuild to enforced multi-page structure with branching by event type.
    Log.info('Attendance form: start rebuild');
    clearItems(form);
    Log.info('Attendance form: cleared existing items');

    const cadets = buildCadetGroups();
    Log.info(`Attendance form: cadet groups built flights=${Object.keys(cadets.byFlight).length} crosstown=${Object.keys(cadets.byCrosstown).length}`);

    // Section 1: respondent info
    let workingForm = form;
    const nameItem = addTextItemSafe(workingForm, 'Name', true);
    workingForm = nameItem.form;

    // Section 2: Event category selection
    const eventCategoryPage = addPageBreakItemSafe(workingForm, 'Event Category', FormApp.PageNavigationType.CONTINUE);
    workingForm = eventCategoryPage.form;
    const eventCategoryItem = addMultipleChoiceItemSafe(workingForm, 'Event Type', true);
    workingForm = eventCategoryItem.form;

    // Section 3: Event list pages for each category (to be populated later)
    const mandoEventsPage = addPageBreakItemSafe(workingForm, 'Mando Events', FormApp.PageNavigationType.CONTINUE);
    workingForm = mandoEventsPage.form;
    const mandoEventList = addListItemSafe(workingForm, 'Select Event (Mando)', undefined, true);
    workingForm = mandoEventList.form;

    const llabEventsPage = addPageBreakItemSafe(workingForm, 'LLAB Events', FormApp.PageNavigationType.CONTINUE);
    workingForm = llabEventsPage.form;
    const llabEventList = addListItemSafe(workingForm, 'Select Event (LLAB)', undefined, true);
    workingForm = llabEventList.form;

    const pocEventsPage = addPageBreakItemSafe(workingForm, 'Third Hour Events', FormApp.PageNavigationType.CONTINUE);
    workingForm = pocEventsPage.form;
    const pocEventList = addListItemSafe(workingForm, 'Select Event (POC Third Hour)', undefined, true);
    workingForm = pocEventList.form;

    const secondaryEventsPage = addPageBreakItemSafe(workingForm, 'Secondary Events', FormApp.PageNavigationType.CONTINUE);
    workingForm = secondaryEventsPage.form;
    const secondaryEventList = addListItemSafe(workingForm, 'Select Event (Secondary)', undefined, true);
    workingForm = secondaryEventList.form;

    const otherEventsPage = addPageBreakItemSafe(workingForm, 'Other Events', FormApp.PageNavigationType.CONTINUE);
    workingForm = otherEventsPage.form;
    const otherEventList = addListItemSafe(workingForm, 'Select Event (Other)', undefined, true);
    workingForm = otherEventList.form;

    // Section 4: Mando branch selector
    const mandoBranch = addPageBreakItemSafe(workingForm, 'Mando Branch', FormApp.PageNavigationType.CONTINUE);
    workingForm = mandoBranch.form;
    const mandoFlight = addMultipleChoiceItemSafe(workingForm, 'Flight / Crosstown (Mando)', true);
    workingForm = mandoFlight.form;
    const mandoFlightItem = mandoFlight.item;
    const mandoFlights = [...Arrays.FLIGHTS.filter((f) => f !== 'Abroad'), 'Trine', 'Valparaiso'];
    const mandoFlightPages: Record<string, GoogleAppsScript.Forms.PageBreakItem> = {};
    mandoFlights.forEach((fName) => {
      const pageResult = addPageBreakItemSafe(workingForm, `Cadets for ${fName} (Mando)`, FormApp.PageNavigationType.SUBMIT);
      workingForm = pageResult.form;
      const page = pageResult.item;
      mandoFlightPages[fName] = page;

      let groupMap: Record<string, string[]> = {};
      if (fName === 'Trine' || fName === 'Valparaiso') {
        const matchKey = Object.keys(cadets.byCrosstown).find((k) => k.toLowerCase().includes(fName.toLowerCase())) || '';
        groupMap = (matchKey && cadets.byCrosstown[matchKey]) || {};
      } else {
        groupMap = cadets.byFlight[fName] || {};
      }

      Object.keys(groupMap)
        .sort((a, b) => b.localeCompare(a, undefined, { sensitivity: 'base' }))
        .forEach((as) => {
          const opts = groupMap[as];
          if (!opts || !opts.length) return;
          const result = addCheckboxItemSafe(workingForm, `Cadets (${fName}) AS ${as} (Mando)`, opts);
          workingForm = result.form;
        });
    });
    mandoFlightItem.setChoices(mandoFlights.map((f) => mandoFlightItem.createChoice(f, mandoFlightPages[f])));
    Log.info(`Attendance form: Mando flight pages=${mandoFlights.length}`);

    // Section 5: LLAB branch selector
    const llabBranch = addPageBreakItemSafe(workingForm, 'LLAB Branch', FormApp.PageNavigationType.CONTINUE);
    workingForm = llabBranch.form;
    const llabFlight = addMultipleChoiceItemSafe(workingForm, 'Flight (LLAB)', true);
    workingForm = llabFlight.form;
    const llabFlightItem = llabFlight.item;
    const llabFlights = Arrays.FLIGHTS.filter((f) => f !== 'Abroad');
    const llabFlightPages: Record<string, GoogleAppsScript.Forms.PageBreakItem> = {};
    llabFlights.forEach((fName) => {
      const pageResult = addPageBreakItemSafe(workingForm, `Cadets for ${fName} (LLAB)`, FormApp.PageNavigationType.SUBMIT);
      workingForm = pageResult.form;
      const page = pageResult.item;
      llabFlightPages[fName] = page;

      const groupMap = cadets.byFlightAll[fName] || cadets.byFlight[fName] || {};
      Object.keys(groupMap)
        .sort((a, b) => b.localeCompare(a, undefined, { sensitivity: 'base' }))
        .forEach((as) => {
          const opts = groupMap[as];
          if (!opts || !opts.length) return;
          const result = addCheckboxItemSafe(workingForm, `Cadets (${fName}) AS ${as} (LLAB)`, opts);
          workingForm = result.form;
        });
    });
    llabFlightItem.setChoices(llabFlights.map((f) => llabFlightItem.createChoice(f, llabFlightPages[f])));
    Log.info(`Attendance form: LLAB flight pages=${llabFlights.length}`);

    // Section 6: POC Third Hour branch (AS300+ only, excludes Abroad)
    const pocPage = addPageBreakItemSafe(workingForm, 'POC Branch', FormApp.PageNavigationType.SUBMIT);
    workingForm = pocPage.form;
    const pocStart = pocPage.item;
    Object.keys(cadets.pocByAs)
      .sort((a, b) => b.localeCompare(a, undefined, { sensitivity: 'base' }))
      .forEach((as) => {
        const opts = cadets.pocByAs[as];
        if (!opts || !opts.length) return;
        const result = addCheckboxItemSafe(workingForm, `Cadets (POC) AS ${as}`, opts);
        workingForm = result.form;
      });
    Log.info(`Attendance form: POC groups=${Object.keys(cadets.pocByAs).length}`);

    // Section 7: Secondary branch (non-abroad) -> submit
    const secondaryPage = addPageBreakItemSafe(workingForm, 'Secondary Branch', FormApp.PageNavigationType.SUBMIT);
    workingForm = secondaryPage.form;
    const secondaryStart = secondaryPage.item;
    Object.keys(cadets.nonAbroadByAs)
      .sort((a, b) => b.localeCompare(a, undefined, { sensitivity: 'base' }))
      .forEach((as) => {
        const opts = cadets.nonAbroadByAs[as];
        if (!opts || !opts.length) return;
        const result = addCheckboxItemSafe(workingForm, `Cadets (Secondary) AS ${as}`, opts);
        workingForm = result.form;
      });
    Log.info(`Attendance form: Secondary groups=${Object.keys(cadets.nonAbroadByAs).length}`);

    // Section 8: Other branch (all cadets) -> submit
    const fallbackPage = addPageBreakItemSafe(workingForm, 'Attendance Branch', FormApp.PageNavigationType.SUBMIT);
    workingForm = fallbackPage.form;
    const fallbackStart = fallbackPage.item;
    Object.keys(cadets.allByAs)
      .sort((a, b) => b.localeCompare(a, undefined, { sensitivity: 'base' }))
      .forEach((as) => {
        const opts = cadets.allByAs[as];
        if (!opts || !opts.length) return;
        const result = addCheckboxItemSafe(workingForm, `Cadets (All) AS ${as}`, opts);
        workingForm = result.form;
      });
    Log.info(`Attendance form: Other/all groups=${Object.keys(cadets.allByAs).length}`);

    // Populate event lists per category and wire navigation
    const mandoEventChoices: GoogleAppsScript.Forms.Choice[] = [];
    const llabEventChoices: GoogleAppsScript.Forms.Choice[] = [];
    const pocEventChoices: GoogleAppsScript.Forms.Choice[] = [];
    const secondaryEventChoices: GoogleAppsScript.Forms.Choice[] = [];
    const otherEventChoices: GoogleAppsScript.Forms.Choice[] = [];
    const eventBuckets = readAttendanceEventBuckets();
    eventBuckets.llab.forEach((name) => llabEventChoices.push(llabEventList.item.createChoice(name, llabBranch.item)));
    eventBuckets.mando.forEach((name) => mandoEventChoices.push(mandoEventList.item.createChoice(name, mandoBranch.item)));
    eventBuckets.secondary.forEach((name) => secondaryEventChoices.push(secondaryEventList.item.createChoice(name, secondaryPage.item)));
    eventBuckets.poc.forEach((name) => pocEventChoices.push(pocEventList.item.createChoice(name, pocPage.item)));
    eventBuckets.other.forEach((name) => otherEventChoices.push(otherEventList.item.createChoice(name, fallbackPage.item)));

    // Set choices for each event list (with fallback if empty)
    if (mandoEventChoices.length) mandoEventList.item.setChoices(mandoEventChoices);
    else mandoEventList.item.setChoices([mandoEventList.item.createChoice('(no events)', mandoBranch.item)]);

    if (llabEventChoices.length) llabEventList.item.setChoices(llabEventChoices);
    else llabEventList.item.setChoices([llabEventList.item.createChoice('(no events)', llabBranch.item)]);

    if (pocEventChoices.length) pocEventList.item.setChoices(pocEventChoices);
    else pocEventList.item.setChoices([pocEventList.item.createChoice('(no events)', pocPage.item)]);

    if (secondaryEventChoices.length) secondaryEventList.item.setChoices(secondaryEventChoices);
    else secondaryEventList.item.setChoices([secondaryEventList.item.createChoice('(no events)', secondaryPage.item)]);

    if (otherEventChoices.length) otherEventList.item.setChoices(otherEventChoices);
    else otherEventList.item.setChoices([otherEventList.item.createChoice('(no events)', fallbackPage.item)]);

    // Wire event category chooser to event list pages
    const categoryChoices: GoogleAppsScript.Forms.Choice[] = [];
    if (mandoEventChoices.length) categoryChoices.push(eventCategoryItem.item.createChoice('Mando PT', mandoEventsPage.item));
    if (llabEventChoices.length) categoryChoices.push(eventCategoryItem.item.createChoice('LLAB', llabEventsPage.item));
    if (pocEventChoices.length) categoryChoices.push(eventCategoryItem.item.createChoice('POC Third Hour', pocEventsPage.item));
    if (secondaryEventChoices.length) categoryChoices.push(eventCategoryItem.item.createChoice('Secondary', secondaryEventsPage.item));
    if (otherEventChoices.length) categoryChoices.push(eventCategoryItem.item.createChoice('Other', otherEventsPage.item));

    if (categoryChoices.length) {
      eventCategoryItem.item.setChoices(categoryChoices);
      Log.info(
        `Attendance form: event categories wired mando=${mandoEventChoices.length} llab=${llabEventChoices.length} poc=${pocEventChoices.length} secondary=${secondaryEventChoices.length} other=${otherEventChoices.length}`
      );
    } else {
      eventCategoryItem.item.setChoices([
        eventCategoryItem.item.createChoice('(set up events first)', fallbackPage.item),
      ]);
      Log.warn('Attendance form: no events found to populate categories');
    }

    const defaultQuestionTitles = countDefaultQuestionTitles(workingForm);
    if (defaultQuestionTitles) {
      Log.warn(`Attendance form: detected ${defaultQuestionTitles} item(s) still titled "Question" after rebuild`);
    }

    Log.info('Attendance form: completed rebuild');
  }

  export function refreshAttendanceFormEventChoices(form: GoogleAppsScript.Forms.Form) {
    const eventTypeItem = findMultipleChoiceItem(form, 'Event Type');
    const mandoEventList = findListItem(form, 'Select Event (Mando)');
    const llabEventList = findListItem(form, 'Select Event (LLAB)');
    const pocEventList = findListItem(form, 'Select Event (POC Third Hour)');
    const secondaryEventList = findListItem(form, 'Select Event (Secondary)');
    const otherEventList = findListItem(form, 'Select Event (Other)');

    if (!eventTypeItem || !mandoEventList || !llabEventList || !pocEventList || !secondaryEventList || !otherEventList) {
      Log.warn('Attendance form: cannot refresh events; expected multi-page attendance items are missing');
      return;
    }

    const mandoEventsPage = findPageBreakItem(form, 'Mando Events');
    const llabEventsPage = findPageBreakItem(form, 'LLAB Events');
    const pocEventsPage = findPageBreakItem(form, 'Third Hour Events');
    const secondaryEventsPage = findPageBreakItem(form, 'Secondary Events');
    const otherEventsPage = findPageBreakItem(form, 'Other Events');
    const mandoStart = findPageBreakItem(form, 'Mando Branch');
    const llabStart = findPageBreakItem(form, 'LLAB Branch');
    const pocStart = findPageBreakItem(form, 'POC Branch');
    const secondaryStart = findPageBreakItem(form, 'Secondary Branch');
    const otherStart = findPageBreakItem(form, 'Attendance Branch');

    const eventBuckets = readAttendanceEventBuckets();

    const setListChoices = (
      item: GoogleAppsScript.Forms.ListItem,
      names: string[],
      target: GoogleAppsScript.Forms.PageBreakItem | null,
    ) => {
      if (names.length && target) {
        item.setChoices(names.map((name) => item.createChoice(name, target)));
        return names.length;
      }
      const fallback = target || FormApp.PageNavigationType.SUBMIT;
      item.setChoices([item.createChoice('(no events)', fallback as any)]);
      return 0;
    };

    const mandoCount = setListChoices(mandoEventList, eventBuckets.mando, mandoStart);
    const llabCount = setListChoices(llabEventList, eventBuckets.llab, llabStart);
    const pocCount = setListChoices(pocEventList, eventBuckets.poc, pocStart);
    const secondaryCount = setListChoices(secondaryEventList, eventBuckets.secondary, secondaryStart);
    const otherCount = setListChoices(otherEventList, eventBuckets.other, otherStart);

    const categoryChoices: GoogleAppsScript.Forms.Choice[] = [];
    if (mandoCount && mandoEventsPage) categoryChoices.push(eventTypeItem.createChoice('Mando PT', mandoEventsPage));
    if (llabCount && llabEventsPage) categoryChoices.push(eventTypeItem.createChoice('LLAB', llabEventsPage));
    if (pocCount && pocEventsPage) categoryChoices.push(eventTypeItem.createChoice('POC Third Hour', pocEventsPage));
    if (secondaryCount && secondaryEventsPage) categoryChoices.push(eventTypeItem.createChoice('Secondary', secondaryEventsPage));
    if (otherCount && otherEventsPage) categoryChoices.push(eventTypeItem.createChoice('Other', otherEventsPage));

    if (categoryChoices.length) {
      eventTypeItem.setChoices(categoryChoices);
      Log.info(
        `Attendance form: refreshed event choices mando=${mandoCount} llab=${llabCount} poc=${pocCount} secondary=${secondaryCount} other=${otherCount}`
      );
      return;
    }

    const fallbackPage = otherEventsPage || otherStart;
    if (fallbackPage) {
      eventTypeItem.setChoices([eventTypeItem.createChoice('(set up events first)', fallbackPage)]);
    } else {
      eventTypeItem.setChoiceValues(['(set up events first)']);
    }
    Log.warn('Attendance form: refreshed event choices but found no categorized events');
  }

  export function ensureExcusalsForm(form: GoogleAppsScript.Forms.Form) {
    // Rebuild form with structured flow: Name → Event Type → Events → Attendance Type → Reason
    rebuildExcusalsForm(form);
  }

  export function rebuildExcusalsForm(form: GoogleAppsScript.Forms.Form) {
    Log.info('Excusals form: start rebuild');
    clearItems(form);
    Log.info('Excusals form: cleared existing items');

    // Section 1: Respondent info
    let workingForm = form;
    const lastNameItem = addTextItemSafe(workingForm, 'Last Name', true);
    workingForm = lastNameItem.form;
    const firstNameItem = addTextItemSafe(workingForm, 'First Name', true);
    workingForm = firstNameItem.form;

    // Section 2: Event category selection (with loop-back navigation)
    const eventCategoryPage = addPageBreakItemSafe(workingForm, 'Event Category', FormApp.PageNavigationType.CONTINUE);
    workingForm = eventCategoryPage.form;
    const eventCategoryItem = addMultipleChoiceItemSafe(workingForm, 'Select Event Type (or Done to continue)', true);
    workingForm = eventCategoryItem.form;

    // Section 3: Event selection pages per category (checkboxes to allow multiple)
    // Each page continues back to Event Category
    const mandoEventsPage = addPageBreakItemSafe(workingForm, 'Mando Events', FormApp.PageNavigationType.CONTINUE);
    workingForm = mandoEventsPage.form;
    const mandoEventList = addCheckboxItemSafe(workingForm, 'Select Event(s) (Mando)', []);
    workingForm = mandoEventList.form;

    const llabEventsPage = addPageBreakItemSafe(workingForm, 'LLAB Events', FormApp.PageNavigationType.CONTINUE);
    workingForm = llabEventsPage.form;
    const llabEventList = addCheckboxItemSafe(workingForm, 'Select Event(s) (LLAB)', []);
    workingForm = llabEventList.form;

    const pocEventsPage = addPageBreakItemSafe(workingForm, 'Third Hour Events', FormApp.PageNavigationType.CONTINUE);
    workingForm = pocEventsPage.form;
    const pocEventList = addCheckboxItemSafe(workingForm, 'Select Event(s) (POC Third Hour)', []);
    workingForm = pocEventList.form;

    const secondaryEventsPage = addPageBreakItemSafe(workingForm, 'Secondary Events', FormApp.PageNavigationType.CONTINUE);
    workingForm = secondaryEventsPage.form;
    const secondaryEventList = addCheckboxItemSafe(workingForm, 'Select Event(s) (Secondary)', []);
    workingForm = secondaryEventList.form;

    const otherEventsPage = addPageBreakItemSafe(workingForm, 'Other Events', FormApp.PageNavigationType.CONTINUE);
    workingForm = otherEventsPage.form;
    const otherEventList = addCheckboxItemSafe(workingForm, 'Select Event(s) (Other)', []);
    workingForm = otherEventList.form;

    // Section 4: Attendance type and reason (shared final section)
    const detailsPage = addPageBreakItemSafe(workingForm, 'Excusal Details', FormApp.PageNavigationType.SUBMIT);
    workingForm = detailsPage.form;
    const attendanceTypeItem = addListItemSafe(workingForm, 'Requested Attendance Type', ['E', 'ES', 'MU', 'MRS'], true);
    workingForm = attendanceTypeItem.form;
    const reasonItem = addTextItemSafe(workingForm, 'Reason', true);
    workingForm = reasonItem.form;

    // Set each event page and the details page to navigate back to Event Category
    // when reached by linear progression. This ensures that after completing any event
    // section, the form loops back to category selection rather than falling through.
    // Users reach Excusal Details via the "Done selecting events" choice (not linear
    // progression), so this doesn't affect the submit flow.
    mandoEventsPage.item.setGoToPage(eventCategoryPage.item);
    llabEventsPage.item.setGoToPage(eventCategoryPage.item);
    pocEventsPage.item.setGoToPage(eventCategoryPage.item);
    secondaryEventsPage.item.setGoToPage(eventCategoryPage.item);
    otherEventsPage.item.setGoToPage(eventCategoryPage.item);
    detailsPage.item.setGoToPage(eventCategoryPage.item);

    // Populate event lists per category
    const backendId = Config.getBackendId();
    const eventsSheet = backendId ? SheetUtils.getSheet(backendId, 'Events Backend') : null;

    const mandoEventChoices: string[] = [];
    const llabEventChoices: string[] = [];
    const pocEventChoices: string[] = [];
    const secondaryEventChoices: string[] = [];
    const otherEventChoices: string[] = [];

    if (eventsSheet) {
      const eventsTable = SheetUtils.readTable(eventsSheet);
      eventsTable.rows.forEach((r) => {
        const name = r['display_name'] || r['attendance_column_label'] || r['event_id'];
        if (!name) return;
        const type = String(r['event_type'] || '').toLowerCase();
        const expectedGroup = String(r['expected_group'] || '').toLowerCase();
        const nameLc = String(name || '').toLowerCase();

        if (type.includes('llab')) {
          llabEventChoices.push(name);
        } else if (type.includes('mando')) {
          mandoEventChoices.push(name);
        } else if (type.includes('secondary')) {
          secondaryEventChoices.push(name);
        } else if (expectedGroup.includes('poc') || type.includes('third hour') || nameLc.includes('poc third hour')) {
          pocEventChoices.push(name);
        } else {
          otherEventChoices.push(name);
        }
      });
    }

    // Set choices for each event list
    if (mandoEventChoices.length) {
      const choices = mandoEventChoices.map(c => mandoEventList.item.createChoice(c));
      mandoEventList.item.setChoices(choices);
    } else {
      mandoEventList.item.setChoices([mandoEventList.item.createChoice('(no events)')]);
    }

    if (llabEventChoices.length) {
      const choices = llabEventChoices.map(c => llabEventList.item.createChoice(c));
      llabEventList.item.setChoices(choices);
    } else {
      llabEventList.item.setChoices([llabEventList.item.createChoice('(no events)')]);
    }

    if (pocEventChoices.length) {
      const choices = pocEventChoices.map(c => pocEventList.item.createChoice(c));
      pocEventList.item.setChoices(choices);
    } else {
      pocEventList.item.setChoices([pocEventList.item.createChoice('(no events)')]);
    }

    if (secondaryEventChoices.length) {
      const choices = secondaryEventChoices.map(c => secondaryEventList.item.createChoice(c));
      secondaryEventList.item.setChoices(choices);
    } else {
      secondaryEventList.item.setChoices([secondaryEventList.item.createChoice('(no events)')]);
    }

    if (otherEventChoices.length) {
      const choices = otherEventChoices.map(c => otherEventList.item.createChoice(c));
      otherEventList.item.setChoices(choices);
    } else {
      otherEventList.item.setChoices([otherEventList.item.createChoice('(no events)')]);
    }

    // Wire event category chooser to event list pages
    const categoryChoices: GoogleAppsScript.Forms.Choice[] = [];
    if (mandoEventChoices.length) categoryChoices.push(eventCategoryItem.item.createChoice('Mando PT', mandoEventsPage.item));
    if (llabEventChoices.length) categoryChoices.push(eventCategoryItem.item.createChoice('LLAB', llabEventsPage.item));
    if (pocEventChoices.length) categoryChoices.push(eventCategoryItem.item.createChoice('POC Third Hour', pocEventsPage.item));
    if (secondaryEventChoices.length) categoryChoices.push(eventCategoryItem.item.createChoice('Secondary', secondaryEventsPage.item));
    if (otherEventChoices.length) categoryChoices.push(eventCategoryItem.item.createChoice('Other', otherEventsPage.item));
    
    // Add "Done" option to proceed to details page
    categoryChoices.push(eventCategoryItem.item.createChoice('Done selecting events', detailsPage.item));

    if (categoryChoices.length > 1) {
      eventCategoryItem.item.setChoices(categoryChoices);
      Log.info(
        `Excusals form: event categories wired mando=${mandoEventChoices.length} llab=${llabEventChoices.length} poc=${pocEventChoices.length} secondary=${secondaryEventChoices.length} other=${otherEventChoices.length}`
      );
    } else {
      eventCategoryItem.item.setChoices([
        eventCategoryItem.item.createChoice('Done selecting events', detailsPage.item),
      ]);
      Log.warn('Excusals form: no events found to populate categories');
    }

    Log.info('Excusals form: completed rebuild');
  }

  export function refreshExcusalsFormEventChoices(form: GoogleAppsScript.Forms.Form) {
    const eventTypeItem = findMultipleChoiceItem(form, 'Select Event Type (or Done to continue)');
    const mandoEventList = form
      .getItems(FormApp.ItemType.CHECKBOX)
      .find((item) => {
        try {
          return String(item.getTitle() || '').trim() === 'Select Event(s) (Mando)';
        } catch {
          return false;
        }
      })
      ?.asCheckboxItem() || null;
    const llabEventList = form
      .getItems(FormApp.ItemType.CHECKBOX)
      .find((item) => {
        try {
          return String(item.getTitle() || '').trim() === 'Select Event(s) (LLAB)';
        } catch {
          return false;
        }
      })
      ?.asCheckboxItem() || null;
    const pocEventList = form
      .getItems(FormApp.ItemType.CHECKBOX)
      .find((item) => {
        try {
          return String(item.getTitle() || '').trim() === 'Select Event(s) (POC Third Hour)';
        } catch {
          return false;
        }
      })
      ?.asCheckboxItem() || null;
    const secondaryEventList = form
      .getItems(FormApp.ItemType.CHECKBOX)
      .find((item) => {
        try {
          return String(item.getTitle() || '').trim() === 'Select Event(s) (Secondary)';
        } catch {
          return false;
        }
      })
      ?.asCheckboxItem() || null;
    const otherEventList = form
      .getItems(FormApp.ItemType.CHECKBOX)
      .find((item) => {
        try {
          return String(item.getTitle() || '').trim() === 'Select Event(s) (Other)';
        } catch {
          return false;
        }
      })
      ?.asCheckboxItem() || null;

    if (!eventTypeItem || !mandoEventList || !llabEventList || !pocEventList || !secondaryEventList || !otherEventList) {
      Log.warn('Excusals form: cannot refresh events; expected multi-page excusals items are missing');
      return;
    }

    const mandoEventsPage = findPageBreakItem(form, 'Mando Events');
    const llabEventsPage = findPageBreakItem(form, 'LLAB Events');
    const pocEventsPage = findPageBreakItem(form, 'Third Hour Events');
    const secondaryEventsPage = findPageBreakItem(form, 'Secondary Events');
    const otherEventsPage = findPageBreakItem(form, 'Other Events');
    const detailsPage = findPageBreakItem(form, 'Excusal Details');

    const eventBuckets = readAttendanceEventBuckets();

    const setCheckboxChoices = (item: GoogleAppsScript.Forms.CheckboxItem, names: string[]) => {
      if (names.length) {
        item.setChoiceValues(names);
        return names.length;
      }
      item.setChoices([item.createChoice('(no events)')]);
      return 0;
    };

    const mandoCount = setCheckboxChoices(mandoEventList, eventBuckets.mando);
    const llabCount = setCheckboxChoices(llabEventList, eventBuckets.llab);
    const pocCount = setCheckboxChoices(pocEventList, eventBuckets.poc);
    const secondaryCount = setCheckboxChoices(secondaryEventList, eventBuckets.secondary);
    const otherCount = setCheckboxChoices(otherEventList, eventBuckets.other);

    const categoryChoices: GoogleAppsScript.Forms.Choice[] = [];
    if (mandoCount && mandoEventsPage) categoryChoices.push(eventTypeItem.createChoice('Mando PT', mandoEventsPage));
    if (llabCount && llabEventsPage) categoryChoices.push(eventTypeItem.createChoice('LLAB', llabEventsPage));
    if (pocCount && pocEventsPage) categoryChoices.push(eventTypeItem.createChoice('POC Third Hour', pocEventsPage));
    if (secondaryCount && secondaryEventsPage) categoryChoices.push(eventTypeItem.createChoice('Secondary', secondaryEventsPage));
    if (otherCount && otherEventsPage) categoryChoices.push(eventTypeItem.createChoice('Other', otherEventsPage));
    if (detailsPage) categoryChoices.push(eventTypeItem.createChoice('Done selecting events', detailsPage));

    if (categoryChoices.length) {
      eventTypeItem.setChoices(categoryChoices);
      Log.info(
        `Excusals form: refreshed event choices mando=${mandoCount} llab=${llabCount} poc=${pocCount} secondary=${secondaryCount} other=${otherCount}`
      );
      return;
    }

    if (detailsPage) {
      eventTypeItem.setChoices([eventTypeItem.createChoice('Done selecting events', detailsPage)]);
    } else {
      eventTypeItem.setChoiceValues(['Done selecting events']);
    }
    Log.warn('Excusals form: refreshed event choices but found no categorized events');
  }
}
