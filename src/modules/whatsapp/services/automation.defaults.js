/**
 * Default automations, inserted once (by systemKey) and then fully editable
 * from Master Admin → WhatsApp → Automations. Re-seeding never overwrites edits.
 */

const opt = (key, label, extra = {}) => ({ key, label, keywords: [], value: "", nextStep: "", automationKey: "", action: "", ...extra });

const nameStep = (next) => ({ id: "ask_name", type: "question", field: "name", text: "Aapka naam batayein 🙂", nextStep: next });
const callbackStep = { id: "ask_callback", type: "question", field: "callbackTime", text: "Aapko call back kab karein? (e.g. Today 5 PM / Tomorrow morning)" };

const leadThanks = "✅ Thank you {{name}}! Hamari team aapse {{callbackTime}} contact karegi.";

export const DEFAULT_AUTOMATIONS = [
  {
    systemKey: "talk_to_team",
    name: "Talk to our team",
    description: "Hands the conversation to a person and pauses automatic replies.",
    priority: 5,
    trigger: { type: "exact_match", keywords: ["talk to team", "talk to our team", "agent", "human", "call me"] },
    actions: [{ type: "human_handover", reason: "Customer asked for the team" }],
  },
  {
    systemKey: "whatsapp_automation",
    name: "WhatsApp Automation enquiry",
    description: "Collects requirements for WhatsApp automation / chatbot projects.",
    priority: 10,
    trigger: { type: "contains", keywords: ["whatsapp automation", "chatbot", "bulk whatsapp", "whatsapp bot"] },
    actions: [{ type: "add_tag", tag: "whatsapp-automation" }],
    steps: [
      { id: "intro", type: "message", text: "🤖 Grow Skills Tech WhatsApp Automation — auto replies, chatbots, bulk campaigns aur CRM integration.", nextStep: "ask_name" },
      nameStep("ask_business"),
      { id: "ask_business", type: "question", field: "business", text: "Aapka business kis type ka hai?", nextStep: "ask_requirement" },
      { id: "ask_requirement", type: "question", field: "requirement", text: "Aapko kya automate karna hai? Short mein batayein.", nextStep: "ask_callback" },
      callbackStep,
    ],
    completionText: leadThanks,
    completionActions: [{ type: "create_lead", interest: "WhatsApp Automation" }],
  },
  {
    systemKey: "software",
    name: "Software services",
    description: "Software / website / app enquiries → service menu → requirement → lead.",
    priority: 20,
    trigger: { type: "contains", keywords: ["software", "website", "app development", "mobile app", "erp", "crm", "billing"] },
    actions: [{ type: "add_tag", tag: "software-enquiry" }],
    steps: [
      {
        id: "service",
        type: "menu",
        field: "service",
        text: "👋 Welcome to Grow Skills Tech!\n\nAap kis service ke baare mein information chahte hain?",
        nextStep: "ask_name",
        options: [
          opt("1", "Website Development"),
          opt("2", "Software Development", { nextStep: "software_type" }),
          opt("3", "Mobile App Development"),
          opt("4", "ERP / Management Software"),
          opt("5", "CRM"),
          opt("6", "WhatsApp Automation"),
          opt("7", "Other"),
        ],
      },
      {
        id: "software_type",
        type: "menu",
        field: "softwareType",
        text: "Kis type ka software chahiye?",
        nextStep: "ask_name",
        options: [
          opt("1", "Billing"),
          opt("2", "ERP"),
          opt("3", "CRM"),
          opt("4", "Institute Management"),
          opt("5", "Custom Software"),
          opt("6", "Other"),
        ],
      },
      nameStep("ask_requirement"),
      { id: "ask_requirement", type: "question", field: "requirement", text: "Apni requirement short mein batayein.", nextStep: "ask_budget" },
      { id: "ask_budget", type: "question", field: "budget", optional: true, text: "Approx budget? (optional — type *skip* to skip)", nextStep: "ask_callback" },
      callbackStep,
    ],
    completionText: leadThanks,
    completionActions: [{ type: "create_lead", interest: "{{service}}" }],
  },
  {
    systemKey: "internship",
    name: "Internship enquiry",
    description: "Internship enquiries → domain → lead.",
    priority: 25,
    trigger: { type: "contains", keywords: ["internship", "intern"] },
    actions: [{ type: "add_tag", tag: "internship-enquiry" }],
    steps: [
      { id: "intro", type: "message", text: "🎓 Grow Skills Tech Internship Program — live projects, mentorship aur certificate.", nextStep: "ask_name" },
      nameStep("ask_college"),
      { id: "ask_college", type: "question", field: "college", text: "Aap kis college / course mein hain?", nextStep: "ask_domain" },
      { id: "ask_domain", type: "question", field: "domain", text: "Kis domain mein internship chahiye? (e.g. Web, App, AI, Marketing)", nextStep: "ask_callback" },
      callbackStep,
    ],
    completionText: leadThanks,
    completionActions: [{ type: "create_lead", interest: "Internship: {{domain}}" }],
  },
  {
    systemKey: "training",
    name: "Training programs",
    description: "Training enquiries. Menu is filled from active Training/Institute courses; the static list is used when none exist.",
    priority: 30,
    trigger: { type: "contains", keywords: ["training", "course", "courses", "class", "classes"] },
    actions: [{ type: "add_tag", tag: "training-enquiry" }],
    steps: [
      {
        id: "course",
        type: "menu",
        field: "course",
        dynamicOptions: "courses",
        text: "👨‍💻 Grow Skills Tech Training Programs\n\nKaunsa program aapko interest karta hai?",
        nextStep: "ask_name",
        options: [
          opt("1", "Full Stack Development", { nextStep: "ask_name" }),
          opt("2", "Web Development"),
          opt("3", "App Development"),
          opt("4", "AI Tools"),
          opt("5", "Internship", { automationKey: "internship" }),
          opt("6", "Placement Assistance"),
        ],
      },
      nameStep("ask_callback"),
      callbackStep,
    ],
    completionText: leadThanks,
    completionActions: [{ type: "create_lead", interest: "{{course}}" }],
  },
  {
    systemKey: "admission",
    name: "Admission enquiry",
    description: "Admission enquiries → course → lead.",
    priority: 40,
    trigger: { type: "keyword", keywords: ["admission", "admissions", "enroll", "enrol"] },
    actions: [{ type: "add_tag", tag: "admission-enquiry" }],
    steps: [
      nameStep("ask_course"),
      { id: "ask_course", type: "question", field: "course", text: "Kis course mein admission chahiye?", nextStep: "ask_city" },
      { id: "ask_city", type: "question", field: "city", optional: true, text: "Aapka city? (optional — type *skip* to skip)", nextStep: "ask_callback" },
      callbackStep,
    ],
    completionText: leadThanks,
    completionActions: [{ type: "create_lead", interest: "Admission: {{course}}" }],
  },
  {
    systemKey: "main_menu",
    name: "Main menu (fallback)",
    description: "Sent when no other automation matches. Option 6 hands over to the team.",
    priority: 1000,
    isFallback: true,
    trigger: { type: "incoming_message", keywords: [] },
    steps: [
      {
        id: "main",
        type: "menu",
        field: "topic",
        text: "Namaste 👋 Grow Skills Tech mein aapka welcome hai.\n\nPlease choose:",
        options: [
          opt("1", "Software Services", { automationKey: "software" }),
          opt("2", "Training Programs", { automationKey: "training" }),
          opt("3", "Internship", { automationKey: "internship" }),
          opt("4", "Admission", { automationKey: "admission" }),
          opt("5", "WhatsApp Automation", { automationKey: "whatsapp_automation" }),
          opt("6", "Talk to our Team", { action: "handover" }),
        ],
      },
    ],
  },
];
