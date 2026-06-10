import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { getAiConfig } from '../config.js';

export async function generateCompletion(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 1000,
  anthropicModel: string = 'claude-sonnet-4-6',
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
      model: 'gemini-2.5-pro',
      systemInstruction: systemPrompt,
    });
    const result = await model.generateContent(userPrompt);
    return result.response.text();
  }

  if (provider === 'openai' || provider === 'openrouter') {
    const client = new OpenAI({
      apiKey,
      baseURL: provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined,
    });
    const response = await client.chat.completions.create({
      model: provider === 'openrouter' ? 'deepseek/deepseek-v3.2' : 'gpt-4o',
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error(`Empty response from ${provider}`);
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
