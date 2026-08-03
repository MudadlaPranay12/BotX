import { SkillProfile, SkillLevel } from './skillProfile';

const LEVEL_INSTRUCTIONS: Record<SkillLevel, string> = {
    BEGINNER: 'Act as a strict, expert coding mentor. Do not say conversational greetings like \'Oh dear\' or \'Let\'s fix this together\'. Output in exactly two sections: 1. ROOT CAUSE: State the precise technical reason the code is failing in simple terms. 2. SUGGESTED FIX: Provide the exact, correct code snippet replacement.',
    INTERMEDIATE: 'State the architectural diagnostic failure precisely. Provide the replacement code block or terminal command immediately. Zero conversational fluff.',
    ADVANCED: 'Give a one-line dense technical root-cause assessment followed immediately by a clean diff code snippet. No conversational filler.',
    EXPERT: 'Give a one-line dense technical root-cause assessment followed immediately by a clean diff code snippet. No conversational filler.',
};

export class VocabularyAdapter {
    static buildPromptModifier(profile: SkillProfile): string {
        const instruction = LEVEL_INSTRUCTIONS[profile.skillLevel];
        console.log(`[VOCABULARY ADAPTER] Applied: ${profile.skillLevel} explanation profile`);
        return instruction;
    }
}
