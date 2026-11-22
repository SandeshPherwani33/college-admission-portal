export type MatchingStudent = {
  id: string;
  preferences: string[];
};

export type MatchingProgram = {
  id: string;
  capacity: number;
  priority: string[];
};

export type MatchingAuditEvent = {
  step: number;
  studentId: string;
  programId: string;
  action: 'proposed' | 'held' | 'rejected' | 'displaced' | 'unmatched';
  detail: string;
};

export type StableMatchingResult = {
  assignments: Array<{ studentId: string; programId: string | null }>;
  auditTrail: MatchingAuditEvent[];
};

export function runGaleShapley(
  students: MatchingStudent[],
  programs: MatchingProgram[],
): StableMatchingResult {
  const studentIds = students.map((student) => student.id);
  const programIds = programs.map((program) => program.id);
  if (new Set(studentIds).size !== studentIds.length) throw new Error('Student IDs must be unique.');
  if (new Set(programIds).size !== programIds.length) throw new Error('Program IDs must be unique.');
  for (const student of students) {
    if (new Set(student.preferences).size !== student.preferences.length) {
      throw new Error(`Student ${student.id} has duplicate preferences.`);
    }
  }
  for (const program of programs) {
    if (!Number.isInteger(program.capacity) || program.capacity < 0) {
      throw new RangeError(`Program ${program.id} must have a non-negative integer capacity.`);
    }
    if (new Set(program.priority).size !== program.priority.length) {
      throw new Error(`Program ${program.id} has duplicate priority entries.`);
    }
  }

  const programsById = new Map(programs.map((program) => [program.id, program]));
  const priorityRank = new Map(programs.map((program) => [
    program.id,
    new Map(program.priority.map((studentId, index) => [studentId, index])),
  ]));
  const nextChoice = new Map(students.map((student) => [student.id, 0]));
  const heldByProgram = new Map<string, string[]>();
  const assignmentByStudent = new Map<string, string>();
  const queue = [...students].sort((left, right) => left.id.localeCompare(right.id)).map((student) => student.id);
  const auditTrail: MatchingAuditEvent[] = [];

  const record = (studentId: string, programId: string, action: MatchingAuditEvent['action'], detail: string) => {
    auditTrail.push({ step: auditTrail.length + 1, studentId, programId, action, detail });
  };

  while (queue.length) {
    const studentId = queue.shift()!;
    const student = students.find((item) => item.id === studentId)!;
    const choiceIndex = nextChoice.get(studentId) ?? student.preferences.length;
    if (choiceIndex >= student.preferences.length) {
      record(studentId, '', 'unmatched', 'No remaining preferred program can hold this student.');
      continue;
    }

    const programId = student.preferences[choiceIndex];
    nextChoice.set(studentId, choiceIndex + 1);
    record(studentId, programId, 'proposed', `Student proposed to preference ${choiceIndex + 1}.`);
    const program = programsById.get(programId);
    if (!program || program.capacity === 0) {
      record(studentId, programId, 'rejected', program ? 'Program capacity is zero.' : 'Program is not in this cohort.');
      queue.push(studentId);
      continue;
    }

    const held = heldByProgram.get(programId) ?? [];
    const ranks = priorityRank.get(programId)!;
    const ordered = [...held, studentId].sort((left, right) => {
      const leftRank = ranks.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = ranks.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.localeCompare(right);
    });
    const accepted = ordered.slice(0, program.capacity);
    const rejected = ordered.slice(program.capacity);
    heldByProgram.set(programId, accepted);

    for (const acceptedId of accepted) {
      assignmentByStudent.set(acceptedId, programId);
    }
    for (const rejectedId of rejected) {
      assignmentByStudent.delete(rejectedId);
      const wasPreviouslyHeld = rejectedId !== studentId;
      record(
        rejectedId,
        programId,
        wasPreviouslyHeld ? 'displaced' : 'rejected',
        wasPreviouslyHeld
          ? 'A higher-priority proposal displaced this held student.'
          : 'Program priority and capacity did not leave a seat for this proposal.',
      );
      queue.push(rejectedId);
    }
    if (accepted.includes(studentId)) {
      record(studentId, programId, 'held', 'Program is holding this proposal at its current priority.');
    }
  }

  return {
    assignments: [...students]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((student) => ({
        studentId: student.id,
        programId: assignmentByStudent.get(student.id) ?? null,
      })),
    auditTrail,
  };
}
