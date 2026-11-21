/*
  Customer tracker settings. The only file to edit for shop details.

  supabaseKey is the project's public "anon" key (the same one dashboard/app.js
  uses). It is meant to be public: every lookup goes through the curated
  get_*_public functions, which check the code and the phone digits.
*/
window.NEO_TRACKER_CONFIG = {
  supabaseUrl: 'https://ggsxkhenzdhaachubrsc.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdnc3hraGVuemRoYWFjaHVicnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTEwNjEsImV4cCI6MjA5NzI4NzA2MX0.bDhUK-qJSgcBEcNdEdOaZGg5vsUF6jH2gbSRQaMhjBo',

  shop: {
    name: 'Neo Tokyo Kochi',
    // TODO(owner): the shop's WhatsApp number, digits only with the country
    // code (e.g. '9198470XXXXX'). Empty: the WhatsApp buttons open WhatsApp's
    // own contact picker with the message filled in.
    whatsapp: '',
    // TODO(owner): the number customers should call, as people write it
    // (e.g. '+91 98470 XXXXX'). Empty: the Call buttons are hidden.
    phone: '',
    // TODO(owner): opening hours shown in the footer, e.g. 'Mon–Sat, 10 am – 8 pm'.
    hours: '',
    mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Neo+Tokyo+Kochi'
  },

  // How often an open result asks the server again (the page also refreshes
  // when the customer comes back to the tab).
  pollMs: 30000
};
