// New aiAssistedTranscript function with revised grammar rules
function aiAssistedTranscript(input) {
    const refined = input.replace(/(\w+)(?=\s)/g, '$1');
    // Add more grammar and stricter word preservation rules here
    return refined;
}