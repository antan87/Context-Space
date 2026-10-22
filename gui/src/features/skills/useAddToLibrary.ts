import { ApiError } from '../../lib/api/client.js';
import { useImportHarnessSkill } from '../../lib/api/queries.js';
import type { SkillItem } from '../../types.js';

export type ShowToast = (message: string, type?: 'success' | 'error' | 'info', duration?: number) => void;

/** "Add to my library": copies a skill a tool ships into My library, where it can be turned on for every tool. */
export function useAddToLibrary(showToast?: ShowToast) {
  const importSkill = useImportHarnessSkill();
  const add = async (skill: SkillItem) => {
    if (!skill.source) return;
    const name = skill.title || skill.id;
    try {
      await importSkill.mutateAsync({ harness: skill.source.harness, id: skill.id });
      showToast?.(`"${name}" is in My library now. Turn it on for a workspace from its Skills tab.`, 'success');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        showToast?.(`My library already has a skill called "${skill.id}".`, 'info');
      } else {
        showToast?.(error instanceof Error ? error.message : `Could not add "${name}" to My library`, 'error');
      }
    }
  };
  return { add, pending: importSkill.isPending ? importSkill.variables : undefined };
}
