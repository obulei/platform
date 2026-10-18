// Single source for the clinic's public identity. The sidebar, the topbar
// breadcrumb, the sign-in card and the browser tab all read from here, so
// renaming the clinic is one edit.
export const CLINIC = {
  name: 'Cyber Hospitals',
  tagline: 'Hospital system',
  mark: 'C'
} as const;
