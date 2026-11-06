INSERT INTO roles (name) VALUES ('ADMIN'), ('ACCOUNT_HOLDER'), ('AUDITOR') ON CONFLICT (name) DO NOTHING;
INSERT INTO accounts (code, kind, currency) VALUES ('SYSTEM_CLEARING_IN', 'system', 'INR'), ('SYSTEM_CLEARING_OUT', 'system', 'INR') ON CONFLICT (code) DO NOTHING;
