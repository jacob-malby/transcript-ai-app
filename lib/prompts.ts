// lib/prompts.ts
export const prompts = {
  quizQuestion: (text: string) =>
    `Generate a question out of the following text and also provide the correct answer to it:\n\n${text}`,

  quizTorF: (text: string) =>
    `Generate a true or false question about a specific part of this text:\n\n${text}`,

  quizWrongAnswers: (question: string) =>
    `Generate 4 incorrect but possible answers to this question that are all different and about random topics:\n\n${question}`,

  summarize2Sentences: (text: string) =>
    `Summarize the following to 2 sentences at a professional reading level:\n\n${text}`,

  interviewQuestion: (text: string) =>
    `Write a question that is answered by the following text:\n\n${text}`,

  interviewSummaryFromQuestion: (question: string, text: string) =>
    `Summarize the following text to a paragraph from the perspective of the question: '${question}':\n\n${text}`,

  infographicTips: (title: string, target: string, summary: string) =>
    `Your job is to collate information for an infographic to support a podcast episode.
The below is a summary for this week's episode, and the infographic will be titled '${title}' aimed at lawyers who ${target}.
Provide 5 tips from the episode around 30 words long each, with each having a tip title.

Summary of episode:
${summary}`,

  blogPost: (blogTopic: string, combinedText: string) =>
    `Generate a 1000-word article summarizing the following. The topic of the blog post is '${blogTopic}'.
Use an active voice. The article you write should be as if you have come up with the points in the document yourself.
Use natural language. Include subheadings, each summarizing a key point, and expand upon each subheading.
You should include specific reference to every piece of legislation and every case mentioned.
If a section or rule number is mentioned, you must include the number in the article.
Integrate all case law into the content of the text. Never create a separate subheading for a specific case.
The article should only be factual about the topic.

CONTENT:
${combinedText}`,

  aiAssistedTranscript: (text: string) =>
    `You are a transcript editor. Lightly clean the following transcript text to make the grammar as clear as possible while STRICTLY preserving all of the speaker's original wording and phrasing. Follow these rules exactly:

1. Do NOT change any words, expressions, or phrasing — only fix grammar where necessary to make the existing words make sense together.
2. Use British spelling throughout (not American): use "s" not "z" (e.g. "recognise" not "recognize"), "viour" not "vior" (e.g. "behaviour"), "lour" not "lor" (e.g. "colour"), "vour" not "vor" (e.g. "favour"), "judgement" not "judgment".
3. Do NOT use en-dashes (–) or em-dashes (—) anywhere.
4. Replace ", and" with "and" (remove the comma before "and").
5. Replace ", but" with "but" (remove the comma before "but").
6. Replace ", or" with "or" (remove the comma before "or").
7. Replace "'cause" with "because".
8. Replace "gonna" with "going to".
9. Replace "gotta" with "got to".
10. Replace "wanna" with "want to".
11. Replace "boutta" with "about to".
12. Replace "outta" with "out of".
13. Do not start sentences with "And" or "But" unless it is truly necessary for the sentence to make sense.
14. When the speaker uses reported or mimicked speech (e.g. "and you're like, stop it" or "I was like, what?"), wrap the quoted/reported speech in double quotation marks (e.g. "and you're like "stop it"" or "I was like "what?"").
15. Do NOT insert any line breaks. The entire output must be a single continuous paragraph with no newlines.

Return only the cleaned text — no explanations, no labels, no extra content.

TEXT:
${text}`,
};