// Form submission handlers: send receipts and (future) processing hooks.

namespace FormHandlers {
	function getNamedValues(e: GoogleAppsScript.Events.FormsOnFormSubmit): Record<string, string[]> {
		return ((e as any).namedValues as Record<string, string[]>) || {};
	}

	function getFirstNamedValue(namedValues: Record<string, string[]>, key: string): string {
		const raw = namedValues[key];
		if (!raw) return '';
		const arr = Array.isArray(raw) ? raw : [raw];
		return String(arr[0] || '').trim();
	}

	function findFirstValue(namedValues: Record<string, string[]>, matcher: (key: string) => boolean): string {
		for (const [k, vals] of Object.entries(namedValues)) {
			if (!matcher(k)) continue;
			const arr = Array.isArray(vals) ? vals : [vals];
			const first = String(arr[0] || '').trim();
			if (first) return first;
		}
		return '';
	}

	function formatTimestamp(dateLike: any): string {
		try {
			const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
			return d.toISOString();
		} catch (err) {
			return new Date().toISOString();
		}
	}

	function appendToBackend(sheetName: string, rows: Record<string, any>[]) {
		SheetUtils.appendRows(Config.getBackendSheet(sheetName), rows);
	}

	function lookupCadetByEmail(email: string, lastName?: string, firstName?: string) {
		const backendId = Config.getBackendId();
		if (!backendId || !email) return null;
		const directorySheet = SheetUtils.getSheet(backendId, 'Directory Backend');
		if (!directorySheet) return null;
		const data = SheetUtils.readTable(directorySheet);
		const lower = email.toLowerCase();
		
		// Try email match first
		const byEmail = data.rows.find((r) => String(r['email'] || '').toLowerCase() === lower);
		if (byEmail) return byEmail;
		
		// Fallback: try matching by last name + first name (case insensitive)
		if (lastName && firstName) {
			const lastLower = lastName.toLowerCase().trim();
			const firstLower = firstName.toLowerCase().trim();
			const byName = data.rows.find((r) => {
				const rLast = String(r['last_name'] || '').toLowerCase().trim();
				const rFirst = String(r['first_name'] || '').toLowerCase().trim();
				return rLast === lastLower && rFirst === firstLower;
			});
			if (byName) {
				Log.info(`lookupCadetByEmail: matched by name for ${firstName} ${lastName} (email ${email} not found)`);
				return byName;
			}
		}
		
		return null;
	}

	function sendReceipt(opts: { to: string; subject: string; body: string; replyTo?: string }) {
		if (!opts.to) return;
		GmailApp.sendEmail(opts.to, opts.subject, opts.body, {
			replyTo: opts.replyTo,
			name: 'SHAMROCK Automations',
		});
	}

	function summarizeResponses(e: GoogleAppsScript.Events.FormsOnFormSubmit): string {
		try {
			const resp = e.response;
			const items = resp.getItemResponses();
			return items
				.map((ir) => `${ir.getItem().getTitle()}: ${ir.getResponse()}`)
				.join('\n');
		} catch (err) {
			return 'Summary unavailable.';
		}
	}

	function getEmail(e: GoogleAppsScript.Events.FormsOnFormSubmit): string {
		const fromResponse = e.response.getRespondentEmail();
		if (fromResponse) return String(fromResponse).trim();
		const nv = (e as any).namedValues || {};
		const keys = ['Email'];
		for (const k of keys) {
			const v = nv[k];
			if (v) {
				const s = Array.isArray(v) ? v[0] : v;
				if (s) return String(s).trim();
			}
		}
		return '';
	}

	function getEditUrl(e: GoogleAppsScript.Events.FormsOnFormSubmit): string {
		try {
			return e.response.getEditResponseUrl();
		} catch (err) {
			return '';
		}
	}

	export function onDirectoryFormSubmit(e: GoogleAppsScript.Events.FormsOnFormSubmit) {
		DirectoryService.handleDirectoryFormSubmission(e);
	}

		export function onAttendanceFormSubmit(e: GoogleAppsScript.Events.FormsOnFormSubmit) {
			const namedValues = getNamedValues(e);
			const submittedByEmail = getEmail(e);
			const submittedAt = formatTimestamp(e.response?.getTimestamp?.() || new Date());

		// Parse the new multi-category form structure
		let submittedByName = '';
		let flightOrCrosstown = ''; // For mando events
		const selectedEvents: string[] = [];
		const cadetsByColumn: Map<string, string[]> = new Map();

		const normalizeToList = (val: any): string[] => {
			if (Array.isArray(val)) {
				return val
					.map((v) => String(v || ''))
					.flatMap((v) => {
						// Google Forms checkbox responses are semicolon-separated: "Last, First; Last, First; ..."
						if (String(v).includes(';')) {
							return v.split(';').map((s: string) => s.trim());
						}
						return [String(v).trim()];
					})
					.filter(Boolean);
			}
			const s = String(val || '').trim();
			if (!s) return [];
			// Google Forms checkbox responses are semicolon-separated
			if (s.includes(';')) {
				return s.split(';').map((x) => x.trim()).filter(Boolean);
			}
			// Single value or non-cadet field
			return [s];
		};

		// Parse item responses
		try {
			e.response.getItemResponses().forEach((ir) => {
				const title = (ir.getItem().getTitle() || '').trim();
				const lower = title.toLowerCase();
				const resp = ir.getResponse();
				const list = normalizeToList(resp);

				// Collect submitter name
				if (!submittedByName && lower.includes('name') && !lower.includes('cadets')) {
					submittedByName = list[0] || String(resp || '').trim();
				}

				// Collect flight/crosstown for mando events
				if (lower.includes('flight') && lower.includes('crosstown')) {
					flightOrCrosstown = list[0] || String(resp || '').trim();
				}

				// Collect all selected events from "Select Event" columns
				if (lower.includes('select event')) {
					const events = normalizeToList(resp);
					events.forEach((ev) => {
						if (ev && !selectedEvents.includes(ev)) {
							selectedEvents.push(ev);
						}
					});
				}

				// Collect cadet selections from columns like "Cadets (Alpha) AS AS400 (Mando)"
				if (lower.includes('cadets') && lower.includes('as ')) {
					const cadets = normalizeToList(resp);
					if (cadets.length > 0) {
						cadetsByColumn.set(title, cadets);
					}
				}
			});
		} catch (err) {
			Log.warn(`attendance parse (items) failed: ${err}`);
		}

		// Fallback to namedValues if needed
		if (!submittedByName) {
			submittedByName =
				getFirstNamedValue(namedValues, 'Name') ||
				findFirstValue(namedValues, (k) => k.toLowerCase().includes('name') && !k.toLowerCase().includes('cadets'));
		}

		if (!flightOrCrosstown) {
			flightOrCrosstown =
				getFirstNamedValue(namedValues, 'Flight / Crosstown (Mando)') ||
				getFirstNamedValue(namedValues, 'Flight / Crosstown') ||
				findFirstValue(namedValues, (k) => k.toLowerCase().includes('flight') && k.toLowerCase().includes('crosstown'));
		}

		if (selectedEvents.length === 0) {
			Object.entries(namedValues).forEach(([key, vals]) => {
				if (key.toLowerCase().includes('select event')) {
					const events = normalizeToList(vals);
					events.forEach((ev) => {
						if (ev && !selectedEvents.includes(ev)) {
							selectedEvents.push(ev);
						}
					});
				}
			});
		}

		if (cadetsByColumn.size === 0) {
			Object.entries(namedValues).forEach(([key, vals]) => {
				const lowerKey = key.toLowerCase();
				if (lowerKey.includes('cadets') && lowerKey.includes('as ')) {
					const cadets = normalizeToList(vals);
					if (cadets.length > 0) {
						cadetsByColumn.set(key, cadets);
					}
				}
			});
		}

		if (selectedEvents.length === 0) {
			Log.warn('No events selected in attendance form submission; skipping.');
			return;
		}

		// For each selected event, determine which cadet columns apply and create a backend entry
		const flightFromDirectory = submittedByEmail ? lookupCadetByEmail(submittedByEmail)?.flight || '' : '';
		const backendRows: any[] = [];

		selectedEvents.forEach((eventName) => {
			// Determine event type from event name pattern
			let eventType = '';
			if (eventName.includes('LLAB') || eventName.includes('TW-')) {
				if (eventName.includes('POC Third Hour')) {
					eventType = 'POC';
				} else if (eventName.includes('Secondary')) {
					eventType = 'Secondary';
				} else if (eventName.includes('LLAB')) {
					eventType = 'LLAB';
				} else {
					eventType = 'Mando';
				}
			} else {
				eventType = 'Other';
			}

			// Collect relevant cadet selections for this event type
			const relevantCadets: string[] = [];
			cadetsByColumn.forEach((cadets, columnTitle) => {
				const columnLower = columnTitle.toLowerCase();
				
				// Match columns by event type
				const matches = 
					(eventType === 'Mando' && columnLower.includes('(mando)')) ||
					(eventType === 'LLAB' && columnLower.includes('(llab)')) ||
					(eventType === 'POC' && columnLower.includes('(poc)')) ||
					(eventType === 'Secondary' && columnLower.includes('(secondary)')) ||
					(eventType === 'Other' && columnLower.includes('(all)'));

				if (matches) {
					cadets.forEach((name) => {
						if (!relevantCadets.includes(name)) {
							relevantCadets.push(name);
						}
					});
				}
			});

			const cadetField = relevantCadets.join('; ');
			const submissionId = `att-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

			// Determine flight field based on event type
			let flightValue = '';
			if (eventType === 'Mando' || eventType === 'LLAB') {
				// For Mando/LLAB, use the selected flight (Alpha-Foxtrot, Trine, Valparaiso)
				flightValue = flightOrCrosstown || flightFromDirectory;
			} else if (eventType === 'Secondary') {
				flightValue = 'Secondary';
			} else if (eventType === 'POC') {
				flightValue = 'POC Third Hour';
			} else if (eventType === 'Other') {
				flightValue = 'Other';
			}

			backendRows.push({
				submission_id: submissionId,
				submitted_at: submittedAt,
				event: eventName,
				attendance_type: 'P',
				email: submittedByEmail,
				name: submittedByName,
				flight: flightValue,
				cadets: cadetField,
			});

			// Incrementally apply the new log entry to the matrices (no full rebuild).
			AttendanceService.applyAttendanceLogEntry({
				event: eventName,
				attendance_type: 'P',
				cadets: cadetField,
			});
		});

		if (backendRows.length > 0) {
			appendToBackend('Attendance Backend', backendRows);
			SetupService.applyAttendanceBackendFormattingPublic();
			Log.info(`Processed attendance submission: ${selectedEvents.length} event(s) from ${submittedByEmail}`);
		}

		// Deliberately omit email receipt for attendance submissions per policy.
	}

	export function onExcusalsFormSubmit(e: GoogleAppsScript.Events.FormsOnFormSubmit) {
		const namedValues = getNamedValues(e);
		const email = getEmail(e);
		const submittedAt = formatTimestamp(e.response?.getTimestamp?.() || new Date());

		// Parse form responses using item responses for robustness
		const events: string[] = [];
		let lastName = '';
		let firstName = '';
		let reason = '';
		let requestedOutcome = 'E'; // default to generic excused
		const itemResponses = e.response?.getItemResponses() || [];

		for (const itemResponse of itemResponses) {
			const title = itemResponse.getItem().getTitle();
			const response = itemResponse.getResponse();

			// Match actual event selection items (checkboxes titled "Select Event(s) (…)")
			// but NOT the category navigation item ("Select Event Type (or Done to continue)")
			const titleLower = title.toLowerCase();
			const isEventSelection = title === 'Event' || (titleLower.includes('select event(s)'));
			const IGNORED_EVENT_VALUES = new Set(['(no events)', 'Done selecting events']);
			if (isEventSelection) {
				if (Array.isArray(response)) {
					response
						.map((e) => String(e || '').trim())
						.filter(Boolean)
						.forEach((eventName) => {
							if (!events.includes(eventName) && !IGNORED_EVENT_VALUES.has(eventName)) events.push(eventName);
						});
				} else {
					const eventRaw = String(response || '').trim();
					eventRaw
						.split(',')
						.map((ev) => ev.trim())
						.filter(Boolean)
						.forEach((eventName) => {
							if (!events.includes(eventName) && !IGNORED_EVENT_VALUES.has(eventName)) events.push(eventName);
						});
				}
			} else if (title === 'Last Name') {
				lastName = String(response || '').trim();
			} else if (title === 'First Name') {
				firstName = String(response || '').trim();
			} else if (title === 'Reason') {
				reason = String(response || '').trim();
			} else if (title === 'Requested Outcome') {
				requestedOutcome = String(response || 'E').trim().toUpperCase();
			}
		}
		if (!Arrays.EXCUSAL_REQUESTED_OUTCOMES.includes(requestedOutcome)) requestedOutcome = 'E';

		if (events.length === 0) {
			Log.warn(`Excusal submission from ${email} has no events; skipping backend append.`);
			return;
		}

		// Look up cadet info from Directory Backend (with name fallback if email not found)
		const cadet = lookupCadetByEmail(email, lastName, firstName);

		// Create one row per event in Excusals Backend
		const rows = events.map((eventName) => {
			const requestId = `exc-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
			return {
				request_id: requestId,
				event: eventName,
				email,
				last_name: cadet?.last_name || lastName,
				first_name: cadet?.first_name || firstName,
				flight: cadet?.flight || '',
				squadron: cadet?.squadron || '',
				status: 'Submitted',
				decision: '',
				decided_by: '',
				decided_at: '',
				requested_outcome: requestedOutcome,
				attendance_effect: 'R',
				prior_attendance_code: ExcusalsService.getCurrentAttendanceCode(
					eventName,
					String(cadet?.last_name || lastName),
					String(cadet?.first_name || firstName),
				),
				submitted_at: submittedAt,
				last_updated_at: submittedAt,
				reason,
			};
		});

		appendToBackend('Excusals Backend', rows);

		// Send notifications and sync to management panel for each row
		rows.forEach((row) => {
			ExcusalsService.auditExcusalSubmission(row);
			ExcusalsService.notifySquadronCommanderOfNewExcusal(row);
			ExcusalsService.syncExcusalToManagementPanel(row);
			ExcusalsService.updateAttendanceOnExcusalSubmission(row);
		});

		Log.info(`Excusal submission processed: ${email} requesting ${requestedOutcome} for ${events.length} event(s)`);

		// Deliberately omit email receipt for excusal submissions per policy.
	}
}
