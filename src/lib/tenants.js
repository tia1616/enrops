// Tenant slug → brand config. J2S is the first tenant. Pattern extends for future operators.

export const TENANTS = {
  j2s: {
    slug: 'j2s',
    name: 'Journey to STEAM',
    shortName: 'J2S',
    tagline: 'Future-Ready Skills. Right After School.',
    heroDek:
      "Hands-on coding, LEGO, game design, and robotics at 30+ Portland-area schools. Small groups, expert instructors, and a kid who can't wait for next week.",
    colors: {
      primary: '#674EE8',
      primaryDark: '#4430AC',
      primarySoft: '#EDE9FE',
      accent: '#F8A638',
      accentDark: '#E85B37',
      ink: '#1A1530',
    },
    displayFont: '"Titan One"',
    bodyFont: '"Nunito Sans"',
    supportEmail: 'info@journeytosteam.com',
    supportPhone: '(971) 258-2178',
    waiverFamily: 'j2s', // to match against waivers.name
  },
};

// District code → full name mapping (per Brand & Copy Rules §10)
export const DISTRICT_NAMES = {
  PPS: 'Portland Public Schools',
  BSD: 'Beaverton School District',
  HSD: 'Hillsboro School District',
  LOSD: 'Lake Oswego School District',
  NCSD: 'North Clackamas School District',
  TTSD: 'Tigard-Tualatin School District',
  Newberg: 'Newberg School District',
  'Happy Valley': 'Happy Valley Parks and Recreation',
  Private: 'Private & Independent Schools',
  Charter: 'Charter Schools',
};

export function districtFullName(code) {
  return DISTRICT_NAMES[code] || code;
}

export function getTenant(slug) {
  return TENANTS[slug] || null;
}
