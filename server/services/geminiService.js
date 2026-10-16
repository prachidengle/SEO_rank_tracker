
import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from "openai";

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const openrouter = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

const seoAnalysisSchema = {
    type: Type.OBJECT,
    properties: {
        overallScore: { type: Type.INTEGER },
        categories: {
            type: Type.OBJECT,
            properties: {
                seo: { type: Type.INTEGER },
                performance: { type: Type.INTEGER },
                accessibility: { type: Type.INTEGER },
                bestPractices: { type: Type.INTEGER },
            },
            required: [
                "seo", "performance", "accessibility", "bestPractices",
            ],
        },
        keywords: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    word: { type: Type.STRING },
                    count: { type: Type.INTEGER },
                    density: { type: Type.NUMBER },
                },
                required: ["word", "count", "density"],
            },
        },
        issues: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    severity: {
                        type: Type.STRING,
                        enum: ["critical", "warning", "info"],
                    },
                    category: { type: Type.STRING },
                    message: { type: Type.STRING },
                    recommendation: { type: Type.STRING },
                },
                required: [
                    "severity", "category", "message", "recommendation",
                ],
            },
        },
    },
    required: ["overallScore", "categories", "keywords", "issues"],
};

const schemaForPrompt = JSON.stringify(seoAnalysisSchema);

function buildPrompt(scrapedData) {
    const meta = scrapedData.metaData || {};
    const headings = scrapedData.headings || {};
    const links = scrapedData.links || {};
    const images = scrapedData.images || {};

    return `You are an expert SEO analyst. Analyze the website data below.

URL: ${scrapedData.url}
Load time: ${scrapedData.loadTime}ms
Status code: ${scrapedData.statusCode}
Page size: ${Math.round((scrapedData.pageSize || 0) / 1024)}KB
Word count: ${scrapedData.wordCount}

META DATA:
${JSON.stringify(meta)}

HEADINGS:
${JSON.stringify(headings)}

LINKS:
${JSON.stringify(links)}

IMAGES:
${JSON.stringify(images)}

PAGE CONTENT (first 3000 characters):
${String(scrapedData.bodyText || "").slice(0, 3000)}

Scoring guidelines:
- Title: ideally 50-60 characters and must exist.
- Description: ideally 150-160 characters and must exist.
- Exactly one H1 is ideal.
- Images should have alt text.
- Load time under 3 seconds is good; under 5 seconds is acceptable.
- Page size under 3MB is good.
- Check viewport, charset, canonical, social tags, internal links,
  word count, and heading hierarchy.
- Return 5-15 actionable issues, critical issues first.
- Severity must be critical, warning, or info.
- Include up to 10 keywords ranked by frequency.

Return ONLY valid JSON matching this structure:
${schemaForPrompt}`;
}

function validateAnalysis(data) {
    if (
        !data ||
        !Number.isInteger(data.overallScore) ||
        !data.categories ||
        !Array.isArray(data.keywords) ||
        !Array.isArray(data.issues)
    ) {
        throw new Error("AI response does not match the expected SEO format.");
    }

    const categoryNames = [
        "seo", "performance", "accessibility", "bestPractices",
    ];

    for (const name of categoryNames) {
        if (!Number.isInteger(data.categories[name])) {
            throw new Error(`AI response is missing category: ${name}`);
        }
    }

    for (const issue of data.issues) {
        if (
            !["critical", "warning", "info"].includes(issue.severity) ||
            typeof issue.category !== "string" ||
            typeof issue.message !== "string" ||
            typeof issue.recommendation !== "string"
        ) {
            throw new Error("AI response contains an invalid SEO issue.");
        }
    }

    for (const keyword of data.keywords) {
        if (
            typeof keyword.word !== "string" ||
            !Number.isInteger(keyword.count) ||
            typeof keyword.density !== "number"
        ) {
            throw new Error("AI response contains an invalid keyword.");
        }
    }

    return data;
}

async function analyzeWithOpenRouter(prompt) {
    if (!process.env.OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY is not configured.");
    }

    // Use a model currently available to your OpenRouter account.
    // Change this ID if your selected model uses a different identifier.
    const model = "google/gemini-2.5-flash";

    const response = await openrouter.chat.completions.create({
    model,
    messages: [
        {
            role: "system",
            content: "You are an SEO analyst. Return only valid JSON.",
        },
        { role: "user", content: prompt },
    ],
    max_tokens: 4000,
    response_format: { type: "json_object" },
});

    const content = response.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error("OpenRouter returned an empty response.");
    }

    return validateAnalysis(JSON.parse(content));
}

export async function analyzeSeoData(scrapedData) {
    const prompt = buildPrompt(scrapedData);
    const models = [
        "gemini-3.8-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
    ];

    let lastError;

    for (const model of models) {
        try {
            console.log(`Trying Gemini model: ${model}`);

            const response = await ai.models.generateContent({
                model,
                contents: prompt,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: seoAnalysisSchema,
                },
            });

            if (!response.text) {
                throw new Error("Gemini returned an empty response.");
            }

            const analysis = validateAnalysis(JSON.parse(response.text));
            console.log(`SEO analysis succeeded with ${model}`);

            return { success: true, data: analysis };
        } catch (error) {
            lastError = error;
            console.error(`Gemini ${model} failed:`, error.message);
        }
    }

    console.warn("Gemini models failed. Trying OpenRouter fallback.");

    try {
        const analysis = await analyzeWithOpenRouter(prompt);
        console.log("SEO analysis succeeded with OpenRouter");

        return { success: true, data: analysis };
    } catch (error) {
        lastError = error;
        console.error("OpenRouter fallback failed:", error.message);

        return {
            success: false,
            error: "AI analysis is temporarily unavailable. Please check the AI provider configuration and try again.",
        };
    }
}
