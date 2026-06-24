-- RBAC Step 3: RLS write-policy rewrite.
-- Spec: docs/handoffs/2026-06-08-roles-and-access-spec.md
--
-- Operational ALL policies on is_org_member let ANY member (incl viewer) write.
-- Split each into: member SELECT (all roles read) + write gated by tier.
--   can_edit_org     -> owner/admin/staff (operational writes; blocks viewer)
--   can_admin_org    -> owner/admin       (settings/branding)
--   can_handle_money -> owner/admin       (money tables: read AND write; blocks staff+viewer)
-- is_platform_admin() preserved everywhere. SELECT-only member policies left as-is
-- (viewers keep read). The write policy's USING also covers DELETE, so viewers can't delete.
--
-- Verified on staging: 0 write-capable policies remain on bare is_org_member;
-- 16 operational ALL + 8 single-command writes (edit), 2 settings (admin), 3 money.

-- ===================== MONEY (owner/admin; read+write) =====================
DROP POLICY IF EXISTS members_manage_org_refunds ON public.refunds;
CREATE POLICY org_money_manage_refunds ON public.refunds FOR ALL
  USING (can_handle_money(organization_id) OR is_platform_admin())
  WITH CHECK (can_handle_money(organization_id) OR is_platform_admin());

DROP POLICY IF EXISTS members_manage_org_installments ON public.installments;
CREATE POLICY org_money_manage_installments ON public.installments FOR ALL
  USING (can_handle_money(organization_id) OR is_platform_admin())
  WITH CHECK (can_handle_money(organization_id) OR is_platform_admin());

DROP POLICY IF EXISTS org_members_manage_instructor_payouts ON public.instructor_payouts;
CREATE POLICY org_money_manage_instructor_payouts ON public.instructor_payouts FOR ALL
  USING (can_handle_money(organization_id) OR is_platform_admin())
  WITH CHECK (can_handle_money(organization_id) OR is_platform_admin());

-- ===================== SETTINGS (read all members; write owner/admin) =====================
DROP POLICY IF EXISTS members_manage_branding ON public.org_branding;
CREATE POLICY members_read_branding ON public.org_branding FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_branding ON public.org_branding FOR ALL
  USING (can_admin_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_admin_org(organization_id) OR is_platform_admin());

DROP POLICY IF EXISTS members_update_own_org ON public.organizations;
CREATE POLICY members_update_own_org ON public.organizations FOR UPDATE
  USING (can_admin_org(id) OR is_platform_admin());

-- ===================== OPERATIONAL ALL TABLES (read all members; write owner/admin/staff) =====================
-- afterschool_survey_state
DROP POLICY IF EXISTS afterschool_survey_state_org_manage ON public.afterschool_survey_state;
CREATE POLICY afterschool_survey_state_org_read ON public.afterschool_survey_state FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY afterschool_survey_state_org_write ON public.afterschool_survey_state FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- assignment_substitutions
DROP POLICY IF EXISTS assignment_substitutions_org_members_manage ON public.assignment_substitutions;
CREATE POLICY assignment_substitutions_org_read ON public.assignment_substitutions FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY assignment_substitutions_org_write ON public.assignment_substitutions FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- automations
DROP POLICY IF EXISTS members_manage_automations ON public.automations;
CREATE POLICY members_read_automations ON public.automations FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_automations ON public.automations FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- custom_reg_fields
DROP POLICY IF EXISTS members_manage_custom_fields ON public.custom_reg_fields;
CREATE POLICY members_read_custom_fields ON public.custom_reg_fields FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_custom_fields ON public.custom_reg_fields FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- district_calendars
DROP POLICY IF EXISTS members_manage_district_calendars ON public.district_calendars;
CREATE POLICY members_read_district_calendars ON public.district_calendars FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_district_calendars ON public.district_calendars FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- enrollment_types
DROP POLICY IF EXISTS members_manage_enrollment_types ON public.enrollment_types;
CREATE POLICY members_read_enrollment_types ON public.enrollment_types FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_enrollment_types ON public.enrollment_types FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- installment_plans (payment-plan templates = config, not money rows)
DROP POLICY IF EXISTS members_manage_installment_plans ON public.installment_plans;
CREATE POLICY members_read_installment_plans ON public.installment_plans FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_installment_plans ON public.installment_plans FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- instructor_term_area_preferences
DROP POLICY IF EXISTS instructor_term_area_pref_org_manage ON public.instructor_term_area_preferences;
CREATE POLICY instructor_term_area_pref_org_read ON public.instructor_term_area_preferences FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY instructor_term_area_pref_org_write ON public.instructor_term_area_preferences FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- instructor_term_availability
DROP POLICY IF EXISTS instructor_term_availability_org_manage ON public.instructor_term_availability;
CREATE POLICY instructor_term_availability_org_read ON public.instructor_term_availability FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY instructor_term_availability_org_write ON public.instructor_term_availability FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- pricing_rules
DROP POLICY IF EXISTS members_manage_pricing_rules ON public.pricing_rules;
CREATE POLICY members_read_pricing_rules ON public.pricing_rules FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_pricing_rules ON public.pricing_rules FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- program_assignments
DROP POLICY IF EXISTS program_assignments_org_members_manage ON public.program_assignments;
CREATE POLICY program_assignments_org_read ON public.program_assignments FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY program_assignments_org_write ON public.program_assignments FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- program_fit_texts
DROP POLICY IF EXISTS members_manage_fit_texts ON public.program_fit_texts;
CREATE POLICY members_read_fit_texts ON public.program_fit_texts FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_fit_texts ON public.program_fit_texts FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- program_locations
DROP POLICY IF EXISTS members_manage_program_locations ON public.program_locations;
CREATE POLICY members_read_program_locations ON public.program_locations FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_program_locations ON public.program_locations FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- programs
DROP POLICY IF EXISTS members_manage_programs ON public.programs;
CREATE POLICY members_read_programs ON public.programs FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_programs ON public.programs FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- promo_codes
DROP POLICY IF EXISTS members_manage_promo_codes ON public.promo_codes;
CREATE POLICY members_read_promo_codes ON public.promo_codes FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_promo_codes ON public.promo_codes FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- waivers
DROP POLICY IF EXISTS members_manage_waivers ON public.waivers;
CREATE POLICY members_read_waivers ON public.waivers FOR SELECT
  USING (is_org_member(organization_id) OR is_platform_admin());
CREATE POLICY members_write_waivers ON public.waivers FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- ===================== SINGLE-COMMAND WRITE POLICIES (swap is_org_member -> tier) =====================
-- automation_edits INSERT (read policy members_read_automation_edits left as-is)
DROP POLICY IF EXISTS members_write_automation_edits ON public.automation_edits;
CREATE POLICY members_write_automation_edits ON public.automation_edits FOR INSERT
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- org_policies (authenticated): insert/update/delete -> can_edit_org; public read left as-is
DROP POLICY IF EXISTS "Org members can insert own org policies" ON public.org_policies;
CREATE POLICY "Org members can insert own org policies" ON public.org_policies FOR INSERT TO authenticated
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());
DROP POLICY IF EXISTS "Org members can update own org policies" ON public.org_policies;
CREATE POLICY "Org members can update own org policies" ON public.org_policies FOR UPDATE TO authenticated
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());
DROP POLICY IF EXISTS "Org members can delete own org policies" ON public.org_policies;
CREATE POLICY "Org members can delete own org policies" ON public.org_policies FOR DELETE TO authenticated
  USING (can_edit_org(organization_id) OR is_platform_admin());

-- parent_org_relationships: member INSERT/UPDATE -> can_edit_org (member SELECT + parent policies untouched)
DROP POLICY IF EXISTS admins_create_parent_org_rels ON public.parent_org_relationships;
CREATE POLICY admins_create_parent_org_rels ON public.parent_org_relationships FOR INSERT
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());
DROP POLICY IF EXISTS members_update_org_rels ON public.parent_org_relationships;
CREATE POLICY members_update_org_rels ON public.parent_org_relationships FOR UPDATE
  USING (can_edit_org(organization_id) OR is_platform_admin());

-- registrations UPDATE -> can_edit_org (member/parent/instructor SELECT left as-is)
DROP POLICY IF EXISTS members_update_org_regs ON public.registrations;
CREATE POLICY members_update_org_regs ON public.registrations FOR UPDATE
  USING (can_edit_org(organization_id) OR is_platform_admin());

-- students UPDATE -> can_edit_org (member/parent/instructor SELECT left as-is)
DROP POLICY IF EXISTS members_update_org_students ON public.students;
CREATE POLICY members_update_org_students ON public.students FOR UPDATE
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());
