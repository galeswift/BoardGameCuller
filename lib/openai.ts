// Minimal OpenAI Chat Completions client for JSON replies.
// OPENAI_MODEL picks the model (default gpt-5-mini).

export const aiConfigured = () => !!process.env.OPENAI_API_KEY;

export async function openaiJson(system: string, user: string, maxTokens: number): Promise<unknown>
{
    const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        cache: 'no-store',
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            response_format: { type: 'json_object' },
            max_completion_tokens: maxTokens,
            // Reasoning models accept an effort level; these tasks don't need much.
            ...(/^(gpt-5|o\d)/.test(model) ? { reasoning_effort: 'low' } : {}),
        }),
    });

    if (!response.ok)
    {
        throw new Error(`OpenAI request failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }

    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return JSON.parse(json.choices?.[0]?.message?.content || '{}');
}
