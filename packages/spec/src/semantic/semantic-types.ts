export type SemanticCode =
  | 'unresolved_binding'
  | 'missing_capability'
  | 'missing_file'
  | 'unreadable_file'
  | 'visibility_widened'; // agent attempt to widen a builder-owned class

/** A semantic defect — schema-valid but wrong against state/capabilities/disk. */
export interface SemanticIssue {
  readonly severity: 'error';
  readonly code: SemanticCode;
  readonly message: string;
  readonly elementKey?: string;
  readonly pointer?: string;
}

export interface SemanticResult {
  readonly valid: boolean;
  readonly issues: readonly SemanticIssue[];
}
