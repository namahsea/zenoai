export function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    console.error('Raw LLM response:', raw);
    throw new Error('Could not extract JSON from LLM response');
  }
  return raw.substring(start, end + 1);
}
