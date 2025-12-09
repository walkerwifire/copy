// Simple address normalization utility
// - Strips apartment/unit tokens (Apt, Unit, Suite, #, etc.)
// - Keeps house number, street name and ZIP (5 or 9 digits) when present
// - Collapses whitespace and punctuation
// Returns: { normalized, houseNumber, street, zip }

function normalizeAddress(raw) {
    if (!raw || typeof raw !== 'string') {
        return { normalized: '', houseNumber: null, street: null, zip: null };
    }

    let s = raw.trim();

    // Normalize punctuation to spaces for easier parsing
    s = s.replace(/[.,;:\/]+/g, ' ');

    // Collapse multiple spaces
    s = s.replace(/\s+/g, ' ');

    // Extract ZIP (5 or 5-4)
    let zipMatch = s.match(/(\b\d{5}(?:-?\d{4})?\b)/);
    let zip = zipMatch ? zipMatch[1].replace(/-/g, '') : null;
    if (zip) {
        // remove zip from string for further parsing
        s = s.replace(zipMatch[0], '').trim();
    }

    // Remove common apartment/unit indicators and trailing unit designators
    // e.g., "Apt 2F", "Unit #3", "Suite 101", "Apartment 4", "#5"
    s = s.replace(/\b(?:apt|apartment|unit|ste|suite|fl|floor|rm|#)\b\s*[:#.-]?\s*\w*-?\w*/ig, '').trim();

    // Also remove patterns like ", Apt 2F" or " APT 2F" already covered; collapse spaces again
    s = s.replace(/\s+/g, ' ');

    // Try to extract leading house number
    let houseNumber = null;
    let houseMatch = s.match(/^(\d+[-\dA-Za-z]*)\s+(.*)$/);
    let street = s;
    if (houseMatch) {
        houseNumber = houseMatch[1];
        street = houseMatch[2];
    }

    // Final cleanup: remove stray commas and multiple spaces
    street = street.replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s+/g, ' ').trim();

    // Compose normalized address: prefer houseNumber + street + zip
    let normalizedParts = [];
    if (houseNumber) normalizedParts.push(houseNumber);
    if (street) normalizedParts.push(street);
    if (zip) normalizedParts.push(zip);
    let normalized = normalizedParts.join(' ').trim();

    return {
        normalized,
        houseNumber: houseNumber || null,
        street: street || null,
        zip: zip || null
    };
}

module.exports = { normalizeAddress };
