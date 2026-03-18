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
  `You are a transcript editor. Clean up the following transcript text to make the grammar, punctuation, and flow as clear as possible while STRICTLY preserving every single word the speaker used. You must not change, add, remove, or alter any words under any circumstances.

RULES TO FOLLOW:

Word Preservation:
1. Do NOT change any words, expressions, or phrasing under any circumstances.
2. Do NOT add or remove any words.
3. The only exceptions to word changes are the specific substitutions listed below.

Filler Sounds and Verbal Crutches (REMOVE THESE):
4. Remove all filler sounds: "umm", "um", "hmm", "hmmm", "uh", "er", "erm", "ah", "uh-huh", "mmm", "mmmm", "mm", etc.
5. These fillers often appear mid-sentence or between clauses and should be deleted entirely with no replacement.

Specific Word/Phrase Substitutions (ONLY these changes allowed):
6. Replace "'cause" with "because".
7. Replace "gonna" with "going to".
8. Replace "gotta" with "got to".
9. Replace "wanna" with "want to".
10. Replace "boutta" with "about to".
11. Replace "outta" with "out of".

Punctuation and Spacing:
12. Use British spelling throughout (not American): use "s" not "z" (e.g. "recognise" not "recognize"), "viour" not "vior" (e.g. "behaviour"), "lour" not "lor" (e.g. "colour"), "vour" not "vor" (e.g. "favour"), "judgement" not "judgment".
13. Do NOT use en-dashes (–) or em-dashes (—) anywhere.
14. Remove commas before conjunctions: replace ", and" with " and", ", but" with " but", ", or" with " or".
15. Add necessary commas for clarity where sentences are complex or have multiple clauses, but only where grammatically required.
16. Fix run-on sentences by adding appropriate punctuation (periods, semicolons, colons) without changing words.
17. Ensure proper capitalization at the start of sentences and for proper nouns.

Sentence Structure:
18. Do not start sentences with "And" or "But" unless absolutely necessary for the sentence to make sense.
19. When the speaker uses reported or mimicked speech (e.g. "and you're like, stop it" or "I was like, what?"), wrap the quoted/reported speech in double quotation marks (e.g. "and you're like \"stop it\"" or "I was like \"what?\"").
20. Fix sentence fragments by connecting them with appropriate punctuation, but never by changing or adding words.

Formatting:
21. Do NOT insert any line breaks. The entire output must be a single continuous paragraph with no newlines.

Return only the cleaned text — no explanations, no labels, no extra content.

TEXT:
${text}`,
};
