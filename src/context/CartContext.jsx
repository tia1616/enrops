import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { calculateCart } from '../lib/pricing.js';

const CartContext = createContext(null);

const STORAGE_KEY = 'enrops_cart_v1';

function emptyChild(index) {
  return {
    child_index: index,
    program_location_id: null,
    school_name: '',
    district: '',
    items: [], // each item: { program, isVip, vipBundle?: [program, program, program] }
    student: {
      first_name: '',
      last_name: '',
      grade: '',
      homeroom_teacher: '',
      room: '',
      birthdate: '',
      allergies: '',
      medical_notes: '',
      special_needs_accommodations: '',
      emergency_contact_name: '',
      emergency_contact_phone: '',
      how_heard: '',
      how_heard_other: '',
      dismissal_method: '', // customizable-registration: released_to_authorized_adult | walks_or_bikes_home | bus | aftercare | other
    },
    // customizable-registration (Chunk 2) — child-level structured people + answers.
    // Written to student_contacts / custom_field_values by create-registration.
    // Only collected when the org has enabled the matching standard/custom question.
    authorized_pickup: [], // [{ first_name, last_name, phone }] — up to 4
    do_not_release: [],    // [{ first_name, last_name }]
    custom_answers: {},    // { [field_key]: value }
    waivers: {}, // { waiverId: { agreed: bool, comments: '' } }
  };
}

function emptyCart() {
  return {
    tenant_slug: 'j2s',
    parent: {
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      address: '',
      // customizable-registration (Chunk 2) — optional second guardian (household-level).
      // Written as a guardian student_contact for each child by create-registration.
      guardian2: { first_name: '', last_name: '', email: '', phone: '' },
    },
    children: [emptyChild(0)],
    active_child_index: 0,
    promo: null, // { code, discount_type, discount_value }
    promo_input: '',
    promo_error: '',
    payment_plan: false,
    vip_enabled: false,
  };
}

export function CartProvider({ children }) {
  const [cart, setCart] = useState(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return emptyCart();
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
    } catch (_) {}
  }, [cart]);

  const activeChild = cart.children[cart.active_child_index];

  function updateChild(index, patch) {
    setCart((c) => {
      const next = { ...c, children: [...c.children] };
      next.children[index] = { ...next.children[index], ...patch };
      return next;
    });
  }

  function updateActiveChild(patch) {
    updateChild(cart.active_child_index, patch);
  }

  function updateActiveStudent(patch) {
    setCart((c) => {
      const next = { ...c, children: [...c.children] };
      const child = next.children[c.active_child_index];
      next.children[c.active_child_index] = {
        ...child,
        student: { ...child.student, ...patch },
      };
      return next;
    });
  }

  function updateParent(patch) {
    setCart((c) => ({ ...c, parent: { ...c.parent, ...patch } }));
  }

  function setActiveChildItem(item) {
    setCart((c) => {
      const next = { ...c, children: [...c.children] };
      next.children[c.active_child_index] = {
        ...next.children[c.active_child_index],
        items: [item],
      };
      return next;
    });
  }

  function setActiveChildSchool(school) {
    setCart((c) => {
      const next = { ...c, children: [...c.children] };
      next.children[c.active_child_index] = {
        ...next.children[c.active_child_index],
        program_location_id: school.id,
        school_name: school.name,
        district: school.district,
      };
      return next;
    });
  }

  function setActiveChildWaiver(waiverId, patch) {
    setCart((c) => {
      const next = { ...c, children: [...c.children] };
      const child = next.children[c.active_child_index];
      next.children[c.active_child_index] = {
        ...child,
        waivers: {
          ...child.waivers,
          [waiverId]: { ...(child.waivers[waiverId] || {}), ...patch },
        },
      };
      return next;
    });
  }

  function addAnotherChild() {
    setCart((c) => {
      const newIndex = c.children.length;
      return {
        ...c,
        children: [...c.children, emptyChild(newIndex)],
        active_child_index: newIndex,
      };
    });
  }

  function removeChild(index) {
    setCart((c) => {
      if (c.children.length <= 1) return c;
      const filtered = c.children.filter((_, i) => i !== index);
      const reindexed = filtered.map((ch, i) => ({ ...ch, child_index: i }));
      const nextActive = Math.min(c.active_child_index, reindexed.length - 1);
      return { ...c, children: reindexed, active_child_index: nextActive };
    });
  }

  function setPromo(promo) {
    setCart((c) => ({ ...c, promo }));
  }

  function setPromoInput(v) {
    setCart((c) => ({ ...c, promo_input: v, promo_error: '' }));
  }

  function setPromoError(e) {
    setCart((c) => ({ ...c, promo_error: e }));
  }

  function togglePaymentPlan() {
    setCart((c) => ({ ...c, payment_plan: !c.payment_plan }));
  }

  function setActiveChildIndex(i) {
    setCart((c) => ({ ...c, active_child_index: i }));
  }

  function clearCart() {
    const fresh = emptyCart();
    setCart(fresh);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  const pricing = useMemo(() => calculateCart(cart), [cart]);

  const value = {
    cart,
    activeChild,
    pricing,
    updateChild,
    updateActiveChild,
    updateActiveStudent,
    updateParent,
    setActiveChildItem,
    setActiveChildSchool,
    setActiveChildWaiver,
    addAnotherChild,
    removeChild,
    setPromo,
    setPromoInput,
    setPromoError,
    togglePaymentPlan,
    setActiveChildIndex,
    clearCart,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside CartProvider');
  return ctx;
}
