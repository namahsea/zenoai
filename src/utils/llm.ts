import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { getAiConfig } from '../config.js';
import { ZENO_MODELS } from '../core/models.js';

export async function generateCompletion(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 1000,
  anthropicModel: string = ZENO_MODELS.anthropic,
): Promise<string> {
  const { provider, apiKey } = await getAiConfig();

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: anthropicModel,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const block = response.content[0];
    if (block.type !== 'text') throw new Error('Unexpected response type from Anthropic');
    return block.text;
  }

  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: ZENO_MODELS.gemini,
      systemInstruction: systemPrompt,
    });
    const result = await model.generateContent(userPrompt);
    return result.response.text();
  }

  if (provider === 'openai') {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: ZENO_MODELS.openai,
      max_output_tokens: maxTokens,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const text = response.output_text;
    if (!text) throw new Error('Empty response from openai');
    return text;
  }

  if (provider === 'openrouter') {
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    const response = await client.chat.completions.create({
      model: ZENO_MODELS.openrouter,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error('Empty response from openrouter');
    return text;
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

export function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    console.error('Raw LLM response:', raw);
    throw new Error('Could not extract JSON from LLM response');
  }
  return raw.substring(start, end + 1);
}
