// trainingGate — shared "instructor must finish required training before being
// assigned work" check. Used by the matchers (match-afterschool, match-instructors)
// to drop untrained instructors from the eligible pool and surface them as a
// "missing requirements" list, mirroring how missing availability surveys are handled.
//
// Returns the SET of instructor ids (from the given list) who are BLOCKED: the org
// has training enabled AND at least one active REQUIRED video, and the instructor is
// missing a passing completion (watched + quiz_passed) for at least one required
// video. When training is off, or the library has no required video (enabled-but-
// empty), nobody is blocked — mirrors gateCheck.

// Structural client type so this helper accepts whichever @supabase/supabase-js
// build a caller imports (match-instructors pins a different esm.sh build than
// match-afterschool; the nominal SupabaseClient types then don't unify). We only
// need `.from(...)`, so a minimal shape avoids coupling to one build's types.
interface DbClient {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

export async function getUntrainedInstructorIds(
  supabase: DbClient,
  organizationId: string,
  instructorIds: string[],
): Promise<Set<string>> {
  const blocked = new Set<string>();
  if (!organizationId || instructorIds.length === 0) return blocked;

  const { data: org } = await supabase
    .from('organizations')
    .select('training_config')
    .eq('id', organizationId)
    .maybeSingle();
  const tcfg = (org?.training_config as { enabled?: boolean } | null) ?? null;
  if (tcfg?.enabled !== true) return blocked;

  const { data: vids } = await supabase
    .from('instructor_training_videos')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('active', true)
    .eq('is_required', true);
  const requiredIds = ((vids ?? []) as Array<{ id: string }>).map((v) => v.id);
  if (requiredIds.length === 0) return blocked; // enabled-but-empty: nobody blocked

  const { data: comps } = await supabase
    .from('instructor_training_completions')
    .select('instructor_id, training_video_id, watched_completed_at, quiz_passed')
    .in('instructor_id', instructorIds)
    .in('training_video_id', requiredIds);

  const passedByInstr = new Map<string, Set<string>>();
  for (const c of comps ?? []) {
    if (c.watched_completed_at && c.quiz_passed) {
      let s = passedByInstr.get(c.instructor_id as string);
      if (!s) { s = new Set<string>(); passedByInstr.set(c.instructor_id as string, s); }
      s.add(c.training_video_id as string);
    }
  }

  for (const id of instructorIds) {
    const passed = passedByInstr.get(id) ?? new Set<string>();
    const allDone = requiredIds.every((rid: string) => passed.has(rid));
    if (!allDone) blocked.add(id);
  }
  return blocked;
}
