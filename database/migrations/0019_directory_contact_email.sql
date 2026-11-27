CREATE TABLE directory_contact_emails (
  person_id TEXT PRIMARY KEY REFERENCES people(person_id),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 1 AND 254)
);
