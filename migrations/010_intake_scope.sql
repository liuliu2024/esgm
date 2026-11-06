ALTER TABLE carbon.case_intake ADD COLUMN intake_scope jsonb;
ALTER TABLE carbon.case_intake ADD CONSTRAINT intake_scope_is_object
    CHECK (jsonb_typeof(intake_scope) = 'object');

CREATE TRIGGER freeze_case_intake_scope
    BEFORE UPDATE OF intake_scope ON carbon.case_intake
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

GRANT INSERT (intake_scope) ON carbon.case_intake TO carbon_app;
