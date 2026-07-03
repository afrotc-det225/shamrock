# Data Legend Ranges (Canonical Option Sets)

This document records the canonical option sets used for Google Sheets data validation (dropdowns) and form option lists.

- Audience: developers/operators maintaining the system.
- Scope: values only (no implementation details).
- Policy: these lists are *authoritative*. The Data Legend sheet in each workbook should reflect these lists via stable named ranges.

## Representation Rules
- Each option set should be stored as a single-column range (one value per row).
- Each option set should be exposed as a named range (name is stable; range coordinates may change).
- Do not inline long dropdown lists directly into validations; validations must reference a range.
- When changing lists, prefer additive changes (append) unless a controlled migration is planned.

## Named Range Registry (Recommended)
These are recommended stable names for the Data Legend workbook ranges.

- `AS_YEARS`
- `FLIGHTS`
- `SQUADRONS`
- `CADET_RANKS`
- `RANKS`
- `UNIVERSITIES`
- `DORMS`
- `CIP_BROAD_AREAS`
- `CIP_CODES`
- `AFSC_OPTIONS`
- `HOME_STATES`
- `FLIGHT_PATH_STATUSES`
- `ATTENDANCE_CODES`
- `EXCUSAL_DECISIONS`
- `EXCUSAL_STATUSES`
- `EXCUSAL_REQUESTED_OUTCOMES`

You may add additional named ranges as needed, but keep names consistent across environments.

---

## AS Years (`AS_YEARS`)
Allowed values:
- AS100
- AS150
- AS200
- AS250
- AS300
- AS400
- AS500
- AS700
- AS800
- AS900

## Cadet Ranks (`CADET_RANKS`)
Allowed values:
- C/4C
- C/3C
- C/2d Lt
- C/1st Lt
- C/Capt
- C/Maj
- C/Lt Col
- C/Col

## Ranks (`RANKS`)
Allowed values:
- C/4C
- C/3C
- C/2d Lt
- C/1st Lt
- C/Capt
- C/Maj
- C/Lt Col
- C/Col
- AB
- Amn
- A1C
- SrA
- SSgt
- TSgt
- MSgt
- SMSgt
- CMSgt
- 2d Lt
- 1st Lt
- Capt
- Maj
- Lt Col
- Col
- Brig Gen
- Maj Gen
- Lt Gen
- Gen

## Flights (`FLIGHTS`)
Allowed values:
- Alpha
- Bravo
- Charlie
- Delta
- Echo
- Foxtrot
- Abroad

## Squadrons (`SQUADRONS`)
Allowed values:
- Blue
- Gold
- Abroad

## Universities (`UNIVERSITIES`)
Allowed values:
- Notre Dame
- St. Mary's
- Holy Cross
- Trine
- Valparaiso

## Dorms (`DORMS`)
Allowed values:
- Cross-Town
- Off-Campus
- Alumni Hall
- Baumer Hall
- Carroll Hall
- Coyle Hall
- Dillon Hall
- Duncan Hall
- Dunne Hall
- Graham Family Hall
- Keenan Hall
- Keough Hall
- Knott Hall
- Morrissey Hall
- O'Neill Family Hall
- Siegfried Hall
- Sorin Hall
- Stanford Hall
- St. Edward's Hall
- Badin Hall
- Breen-Phillips Hall
- Cavanaugh Hall
- Farley Hall
- Flaherty Hall
- Grojean Hall
- Johnson Family Hall
- Lewis Hall
- Lyons Hall
- McGlinn Hall
- Pasquerilla East Hall
- Pasquerilla West Hall
- Ryan Hall
- Walsh Hall
- Welsh Family Hall
- Undergraduate Community at Fischer
- Fischer Graduate Residences

## Home States (`HOME_STATES`)
Rule:
- Use full US state names, capitalized (e.g., “Illinois”, “California”).

Canonical values:
- Alabama
- Alaska
- Arizona
- Arkansas
- California
- Colorado
- Connecticut
- Delaware
- Florida
- Georgia
- Hawaii
- Idaho
- Illinois
- Indiana
- Iowa
- Kansas
- Kentucky
- Louisiana
- Maine
- Maryland
- Massachusetts
- Michigan
- Minnesota
- Mississippi
- Missouri
- Montana
- Nebraska
- Nevada
- New Hampshire
- New Jersey
- New Mexico
- New York
- North Carolina
- North Dakota
- Ohio
- Oklahoma
- Oregon
- Pennsylvania
- Rhode Island
- South Carolina
- South Dakota
- Tennessee
- Texas
- Utah
- Vermont
- Virginia
- Washington
- West Virginia
- Wisconsin
- Wyoming

## CIP Broad Areas (`CIP_BROAD_AREAS`)
Allowed values:
- 01 - Agricultural/Animal/Plant/Veterinary Science and Related Fields
- 03 - Natural Resources and Conservation
- 04 - Architecture and Related Services
- 05 - Area, Ethnic, Cultural, Gender, and Group Studies
- 09 - Communication, Journalism, and Related Programs
- 10 - Communications Technologies/Technicians and Support Services
- 11 - Computer and Information Sciences and Support Services
- 12 - Culinary, Entertainment, and Personal Services
- 13 - Education
- 14 - Engineering
- 15 - Engineering/Engineering-Related Technologies/Technicians
- 16 - Foreign Languages, Literatures, and Linguistics
- 19 - Family and Consumer Sciences/Human Sciences
- 21 - Reserved
- 22 - Legal Professions and Studies
- 23 - English Language and Literature/Letters
- 24 - Liberal Arts and Sciences, General Studies and Humanities
- 25 - Library Science
- 26 - Biological and Biomedical Sciences
- 27 - Mathematics and Statistics
- 28 - Military Science, Leadership and Operational Art
- 29 - Military Technologies and Applied Sciences
- 30 - Multi/Interdisciplinary Studies
- 31 - Parks, Recreation, Leisure, Fitness, and Kinesiology
- 32 - Basic Skills and Developmental/Remedial Education
- 33 - Citizenship Activities
- 34 - Health-Related Knowledge and Skills
- 35 - Interpersonal and Social Skills
- 36 - Leisure and Recreational Activities
- 37 - Personal Awareness and Self-Improvement
- 38 - Philosophy and Religious Studies
- 39 - Theology and Religious Vocations
- 40 - Physical Sciences
- 41 - Science Technologies/Technicians
- 42 - Psychology
- 43 - Homeland Security, Law Enforcement, Firefighting and Related Protective Services
- 44 - Public Administration and Social Service Professions
- 45 - Social Sciences
- 46 - Construction Trades
- 47 - Mechanic and Repair Technologies/Technicians
- 48 - Precision Production
- 49 - Transportation and Materials Moving
- 50 - Visual and Performing Arts
- 51 - Health Professions and Related Programs
- 52 - Business, Management, Marketing, and Related Support Services
- 53 - High School/Secondary Diplomas and Certificates
- 54 - History
- 55 - Reserved
- 60 - Health Professions Residency/Fellowship Programs
- 61 - Medical Residency/Fellowship Programs

## CIP Codes (`CIP_CODES`)
Rule:
- Must be six digits in the format `XX.XXXX` (example: `11.0701`).
- `CIP_CODES` should contain only values that meet this format.

## AFSC Options (`AFSC_OPTIONS`)
Allowed values:
- Undecided
- Space Force
- 11X - Pilot
- 12X - Combat Systems Officer
- 13A - Astronaut
- 13B - Air Battle Manager
- 13H - Aerospace Physiologist
- 13M - Airfield Operations
- 13N - Nuclear and Missile Operations
- 13O - Multi-Domain Warfare Officer
- 13S - Space Operations
- 13Z - Rated Multi-Domain Warfare Officer
- 14F - Information Operations
- 14N - Intelligence
- 15A - Operations Analysis Officer
- 15W - Weather and Environmental Sciences
- 16F - Foreign Area Officer (FAO)
- 16G - Air Force Operations Staff Officer
- 16K - Software Development Officer (SDO)
- 16P - Political-Military Affairs Strategist (PAS)
- 16R - Planning and Programming
- 16Z - Rated Foreign Area Officer (FAO)
- 17D - Warfighter Communications
- 17S - Cyberspace Effects Operations
- 17W - Warfighter Communications & IT Systems
- 17Y - Cyber Effects & Warfare Operations
- 18X - Remotely Piloted Aircraft (RPA) Pilot
- 19G - Space Warfare Officer
- 19Z - Special Warfare
- 21A - Aircraft Maintenance
- 21M - Munitions and Missile Maintenance
- 21R - Logistics Readiness
- 31P - Security Forces
- 32E - Civil Engineer
- 35B - Band
- 35P - Public Affairs
- 38F - Force Support
- 41A - Healthcare Administrator
- 42X - Biomedical Clinician
- 43X - Biomedical Specialists
- 44X - Physician
- 46X - Nurse
- 47X - Dental
- 48X - Aerospace Medicine
- 51J - Judge Advocate
- 52R - Chaplain
- 61C - Chemist/Nuclear Chemist
- 61D - Physicist/Nuclear Engineer
- 62E - Developmental Engineer
- 62S - Materiel Leader
- 63A - Acquisition Manager
- 64P - Contracting
- 65F - Financial Management
- 65W - Cost Analysis
- 71S - Special Investigations
- 92F0 - Foreign Area Officer (FAO) Trainee
- 92J0 - Non-designated Lawyer
- 92J1 - AFROTC Educational Delay Law Student
- 92J2 - Funded Legal Education Program Law Student
- 92J3 - Excess Leave Law Student
- 92M0 - HPSP Medical Student
- 92M1 - USUHS Student
- 92M2 - HPSP Biomedical Science Student
- 92P0 - Physician Assistant Student
- 92T0 - Pilot Trainee
- 92T1 - Combat Systems Officer Trainee
- 92T2 - Air Battle Manager Trainee
- 92T3 - Remotely Piloted Aircraft Pilot Trainee

## Flight Path Statuses (`FLIGHT_PATH_STATUSES`)
Allowed values:
- Participating 1/4
- Enrolled 2/4
- Active 3/4
- Ready 4/4
- Inactive
- Commissioned
- Dropped

Non-operational statuses:
- Inactive
- Commissioned
- Dropped

## Attendance Codes (`ATTENDANCE_CODES`)
Represent attendance codes as a single-column Data Legend option list. The code meanings are:

Canonical rows:
- P | Present
- T | Tardy
- A | Absent, unresolved
- R | Request pending
- D | Request denied before event; attendance still required
- U | Unexcused absence
- E | Excused
- ES | Excused – Sport
- MED | Medical
- N/A | Cancelled / Not Applicable

Notes:
- Blank is allowed in attendance cells to mean “not taken / not occurred yet”.
- `P`, `T`, `E`, `ES`, and `MED` count as attendance credit.
- `A` and `U` count against attendance.
- `R`, `D`, `N/A`, and blank are neutral until resolved.

## Excusal Decisions (`EXCUSAL_DECISIONS`)
Allowed values:
- Approved
- Denied
- Withdrawn
- Superseded

## Excusal Statuses (`EXCUSAL_STATUSES`)
Allowed values:
- Submitted
- Approved
- Denied
- Withdrawn
- Superseded

## Excusal Requested Outcomes (`EXCUSAL_REQUESTED_OUTCOMES`)
Allowed values:
- P
- T
- E
- ES
- MED
