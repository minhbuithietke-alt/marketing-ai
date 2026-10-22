/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Sidebar, ActiveModule } from './components/Sidebar';
import { FanpageDashboard } from './components/FanpageDashboard';
import { UnifiedInbox } from './components/UnifiedInbox';
import { PrintingBrainRules } from './components/PrintingBrainRules';
import { MarketingAssistant } from './components/MarketingAssistant';
import { SimulateLeadModal } from './components/SimulateLeadModal';
import { FacebookOAuthWebhookModal } from './components/FacebookOAuthWebhookModal';
import {
  INITIAL_CONVERSATIONS,
  INITIAL_FANPAGES,
} from './data/initialData';
import {
  AIAnalysisResult,
  Conversation,
  FacebookWebhookEventItem,
  FanpageConfig,
  FirestoreSavedOrder,
  InteractionType,
  LeadStatus,
  PageId,
  TechnicalSpec,
} from './types';
import {
  detectProductFromText,
  safeParseAIAnalysisJson,
} from './utils/printingBrain';
import {
  auth,
  db,
  googleProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  doc,
  setDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  testFirestoreConnection,
  handleFirestoreError,
  OperationType,
  User,
} from './firebase';
import { Menu, X, Plus, Link2 } from 'lucide-react';

export default function App() {
  const [activeModule, setActiveModule] = useState<ActiveModule>('dashboard');
  const [pages, setPages] = useState<FanpageConfig[]>(INITIAL_FANPAGES);
  const [selectedPage, setSelectedPage] = useState<PageId | 'all'>('all');
  const [conversations, setConversations] = useState<Conversation[]>(
    INITIAL_CONVERSATIONS
  );
  const [activeConversationId, setActiveConversationId] =
    useState<string>('conv-1');
  const [autoPilot, setAutoPilot] = useState<boolean>(true);
  const [isAiProcessing, setIsAiProcessing] = useState<boolean>(false);
  const [simulateModalOpen, setSimulateModalOpen] = useState<boolean>(false);
  const [fbModalOpen, setFbModalOpen] = useState<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);

  // Firebase Auth & Firestore State
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(false);
  const [firestoreOrders, setFirestoreOrders] = useState<FirestoreSavedOrder[]>(
    []
  );

  // Validate connection to Firestore on boot (Mandatory per firebase-integration-rpc skill)
  useEffect(() => {
    testFirestoreConnection();
  }, []);

  // Track Firebase Auth State & Sync Staff Profile
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (user) {
        const staffPath = `staff_profiles/${user.uid}`;
        try {
          const isAdminEmail = user.email === 'baobitienphatgialai@gmail.com';
          await setDoc(
            doc(db, 'staff_profiles', user.uid),
            {
              uid: user.uid.slice(0, 128),
              displayName: (user.displayName || 'Nhân viên Tiến Phát').slice(
                0,
                120
              ),
              email: (user.email || 'staff@tienphat.vn').slice(0, 160),
              role: isAdminEmail ? 'admin' : 'staff',
              connectedPagesCount: 3,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, staffPath);
        }
      } else {
        setFirestoreOrders([]);
      }
    });
    return () => unsubscribe();
  }, []);

  // Listen to Staff's Saved Orders and Connected Fanpages on Firestore
  useEffect(() => {
    if (!currentUser) return;

    const ordersQuery = query(
      collection(db, 'orders'),
      where('staffUid', '==', currentUser.uid)
    );

    const unsubOrders = onSnapshot(
      ordersQuery,
      (snapshot) => {
        const loaded: FirestoreSavedOrder[] = snapshot.docs.map((docSnap) => {
          const d = docSnap.data();
          return {
            id: docSnap.id,
            orderCode: String(d.orderCode || docSnap.id),
            staffUid: String(d.staffUid || ''),
            staffEmail: String(d.staffEmail || ''),
            pageId: (d.pageId as PageId) || 'page2',
            pageName: String(d.pageName || ''),
            customerName: String(d.customerName || ''),
            interactionType: String(d.interactionType || ''),
            status: String(d.status || ''),
            product: String(d.product || ''),
            dimensions: String(d.dimensions || ''),
            quantity: String(d.quantity || ''),
            materialAndFinishing: String(d.materialAndFinishing || ''),
            designFileStatus: String(d.designFileStatus || ''),
            phoneOrZalo: String(d.phoneOrZalo || ''),
            deliveryAddress: String(d.deliveryAddress || ''),
            commentHidden: Boolean(d.commentHidden),
            createdAtText: 'Đã đồng bộ Firestore',
          };
        });
        setFirestoreOrders(loaded);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'orders');
      }
    );

    const pagesQuery = query(
      collection(db, 'connected_fanpages'),
      where('staffUid', '==', currentUser.uid)
    );

    const unsubPages = onSnapshot(
      pagesQuery,
      (snapshot) => {
        if (snapshot.empty) return;
        setPages((prev) =>
          prev.map((p) => {
            const matchDoc = snapshot.docs.find(
              (d) => d.data().slotId === p.id
            );
            if (!matchDoc) return p;
            const data = matchDoc.data();
            return {
              ...p,
              name: String(data.name || p.name),
              specialty: String(data.specialty || p.specialty),
              fbPageId: String(data.fbPageId || p.fbPageId || ''),
              webhookSubscribed: Boolean(data.webhookSubscribed ?? true),
              connectedViaOAuth: true,
            };
          })
        );
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'connected_fanpages');
      }
    );

    return () => {
      unsubOrders();
      unsubPages();
    };
  }, [currentUser]);

  const handleStaffLogin = async () => {
    setAuthLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error('Google Sign-In error:', err);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleStaffLogout = async () => {
    await signOut(auth);
  };

  const formatNowTime = () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  };

  const handleUpdatePageName = async (pageId: PageId, newName: string) => {
    const targetPage = pages.find((p) => p.id === pageId);
    setPages((prev) =>
      prev.map((p) => (p.id === pageId ? { ...p, name: newName } : p))
    );

    if (currentUser && targetPage) {
      const docId = `${currentUser.uid}_${pageId}`;
      try {
        await setDoc(doc(db, 'connected_fanpages', docId), {
          slotId: pageId,
          staffUid: currentUser.uid.slice(0, 128),
          fbPageId: (targetPage.fbPageId || `10882341000_${pageId}`).slice(
            0,
            100
          ),
          name: newName.slice(0, 120),
          specialty: targetPage.specialty.slice(0, 250),
          webhookSubscribed: true,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(
          error,
          OperationType.WRITE,
          `connected_fanpages/${docId}`
        );
      }
    }
  };

  const handleConnectThreePages = async (
    updatedPages: {
      id: PageId;
      name: string;
      specialty: string;
      fbPageId: string;
      webhookSubscribed: boolean;
    }[]
  ) => {
    setPages((prev) =>
      prev.map((p) => {
        const found = updatedPages.find((u) => u.id === p.id);
        if (!found) return p;
        return {
          ...p,
          name: found.name,
          specialty: found.specialty,
          fbPageId: found.fbPageId,
          webhookSubscribed: found.webhookSubscribed,
          connectedViaOAuth: true,
        };
      })
    );

    if (currentUser) {
      for (const up of updatedPages.slice(0, 3)) {
        const docId = `${currentUser.uid}_${up.id}`;
        try {
          await setDoc(doc(db, 'connected_fanpages', docId), {
            slotId: up.id,
            staffUid: currentUser.uid.slice(0, 128),
            fbPageId: up.fbPageId.slice(0, 100),
            name: up.name.slice(0, 120),
            specialty: up.specialty.slice(0, 250),
            webhookSubscribed: Boolean(up.webhookSubscribed),
            updatedAt: serverTimestamp(),
          });
        } catch (error) {
          handleFirestoreError(
            error,
            OperationType.WRITE,
            `connected_fanpages/${docId}`
          );
        }
      }
    }
  };

  const handleWebhookLeadReceived = (event: FacebookWebhookEventItem) => {
    const newConvId = `conv-wh-${Date.now()}`;
    const customerMsg = {
      id: `m-wh-cust-${Date.now()}`,
      sender: 'customer' as const,
      content: event.incomingText,
      timestamp: event.receivedAt,
      isComment: event.interactionType === 'Bình luận (Comment)',
      isHiddenComment: event.shouldHideComment,
    };
    const aiMsg = {
      id: `m-wh-ai-${Date.now()}`,
      sender: 'ai' as const,
      content: event.aiReply,
      timestamp: event.receivedAt,
    };

    const newConv: Conversation = {
      id: newConvId,
      pageId: event.mappedSlotId,
      customerName: event.senderName,
      customerHandle: `fb.com/${event.senderId}`,
      interactionType: event.interactionType,
      status: event.status,
      commentHidden: event.shouldHideComment,
      savedOrder: false,
      updatedAt: 'Webhook vừa nhận',
      messages: [customerMsg, aiMsg],
      specs: event.specs,
    };

    setConversations((prev) => [newConv, ...prev]);
    setActiveConversationId(newConvId);
  };

  const callServerAiAnalyze = async (payload: {
    customerMessage: string;
    conversationHistory: { sender: string; content: string }[];
    currentSpecs: TechnicalSpec;
    interactionType: InteractionType;
    pageId: PageId;
  }): Promise<AIAnalysisResult> => {
    const pageObj = pages.find((p) => p.id === payload.pageId);
    try {
      const response = await fetch('/api/ai/analyze-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          pageName: pageObj?.name || 'Xưởng Bao Bì Tiến Phát',
        }),
      });
      if (!response.ok) {
        throw new Error('Server response not ok');
      }
      const data = await response.json();
      if (data?.result) {
        return data.result as AIAnalysisResult;
      }
      return safeParseAIAnalysisJson(
        null,
        payload.customerMessage,
        payload.currentSpecs,
        payload.interactionType,
        payload.pageId
      );
    } catch {
      return safeParseAIAnalysisJson(
        null,
        payload.customerMessage,
        payload.currentSpecs,
        payload.interactionType,
        payload.pageId
      );
    }
  };

  const handleSendCustomerMessage = async (convId: string, text: string) => {
    const targetConv = conversations.find((c) => c.id === convId);
    if (!targetConv) return;

    const timeStr = formatNowTime();
    const customerMsg = {
      id: `msg-${Date.now()}`,
      sender: 'customer' as const,
      content: text,
      timestamp: timeStr,
      isComment: targetConv.interactionType === 'Bình luận (Comment)',
    };

    const updatedHistory = [...targetConv.messages, customerMsg];

    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              updatedAt: 'Vừa xong',
              messages: updatedHistory,
            }
          : c
      )
    );

    if (autoPilot) {
      setIsAiProcessing(true);
      try {
        const aiResult = await callServerAiAnalyze({
          customerMessage: text,
          conversationHistory: updatedHistory.map((m) => ({
            sender: m.sender,
            content: m.content,
          })),
          currentSpecs: targetConv.specs,
          interactionType: targetConv.interactionType,
          pageId: targetConv.pageId,
        });

        const aiMsg = {
          id: `msg-ai-${Date.now()}`,
          sender: 'ai' as const,
          content: aiResult.replyMessage,
          timestamp: formatNowTime(),
        };

        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  status: aiResult.status,
                  commentHidden: c.commentHidden || aiResult.shouldHideComment,
                  specs: aiResult.specs,
                  messages: [...updatedHistory, aiMsg],
                }
              : c
          )
        );
      } finally {
        setIsAiProcessing(false);
      }
    }
  };

  const handleTriggerAiReplyNow = async (convId: string) => {
    const targetConv = conversations.find((c) => c.id === convId);
    if (!targetConv || targetConv.messages.length === 0) return;

    const lastCustomerMsg =
      [...targetConv.messages].reverse().find((m) => m.sender === 'customer') ||
      targetConv.messages[targetConv.messages.length - 1];

    setIsAiProcessing(true);
    try {
      const aiResult = await callServerAiAnalyze({
        customerMessage: lastCustomerMsg.content,
        conversationHistory: targetConv.messages.map((m) => ({
          sender: m.sender,
          content: m.content,
        })),
        currentSpecs: targetConv.specs,
        interactionType: targetConv.interactionType,
        pageId: targetConv.pageId,
      });

      const aiMsg = {
        id: `msg-ai-${Date.now()}`,
        sender: 'ai' as const,
        content: aiResult.replyMessage,
        timestamp: formatNowTime(),
      };

      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                status: aiResult.status,
                commentHidden: c.commentHidden || aiResult.shouldHideComment,
                specs: aiResult.specs,
                messages: [...c.messages, aiMsg],
              }
            : c
        )
      );
    } finally {
      setIsAiProcessing(false);
    }
  };

  const handleSendStaffReply = (convId: string, text: string) => {
    const staffMsg = {
      id: `msg-staff-${Date.now()}`,
      sender: 'staff' as const,
      content: text,
      timestamp: formatNowTime(),
    };
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              updatedAt: 'Vừa xong',
              messages: [...c.messages, staffMsg],
            }
          : c
      )
    );
  };

  const handleSimulateNewLead = async (payload: {
    pageId: PageId;
    customerName: string;
    interactionType: InteractionType;
    message: string;
  }) => {
    const newId = `conv-${Date.now()}`;
    const timeStr = formatNowTime();
    const initialSpecs: TechnicalSpec = {
      product:
        detectProductFromText(payload.message, payload.pageId) ||
        'Ấn phẩm in ấn / Bao bì',
      dimensions: 'Chưa xác định',
      quantity: 'Chưa xác định',
      materialAndFinishing: 'Chưa xác định',
      designFileStatus: 'Chưa xác định',
      phoneOrZalo: 'Chưa có SĐT',
      deliveryAddress: 'Chưa xác định',
    };

    const firstMsg = {
      id: `msg-${Date.now()}`,
      sender: 'customer' as const,
      content: payload.message,
      timestamp: timeStr,
      isComment: payload.interactionType === 'Bình luận (Comment)',
    };

    const newConv: Conversation = {
      id: newId,
      pageId: payload.pageId,
      customerName: payload.customerName,
      customerHandle: `fb.com/khachhang.${Date.now().toString().slice(-4)}`,
      interactionType: payload.interactionType,
      status: 'Đang hỏi quy cách',
      commentHidden: false,
      savedOrder: false,
      updatedAt: 'Vừa xong',
      messages: [firstMsg],
      specs: initialSpecs,
    };

    setConversations((prev) => [newConv, ...prev]);
    setActiveConversationId(newId);
    setSelectedPage('all');
    setActiveModule('inbox');

    if (autoPilot) {
      setIsAiProcessing(true);
      try {
        const aiResult = await callServerAiAnalyze({
          customerMessage: payload.message,
          conversationHistory: [{ sender: 'customer', content: payload.message }],
          currentSpecs: initialSpecs,
          interactionType: payload.interactionType,
          pageId: payload.pageId,
        });

        const aiMsg = {
          id: `msg-ai-${Date.now()}`,
          sender: 'ai' as const,
          content: aiResult.replyMessage,
          timestamp: formatNowTime(),
        };

        setConversations((prev) =>
          prev.map((c) =>
            c.id === newId
              ? {
                  ...c,
                  status: aiResult.status,
                  commentHidden: aiResult.shouldHideComment,
                  specs: aiResult.specs,
                  messages: [
                    { ...firstMsg, isHiddenComment: aiResult.shouldHideComment },
                    aiMsg,
                  ],
                }
              : c
          )
        );
      } finally {
        setIsAiProcessing(false);
      }
    }
  };

  const handleUpdateSpecs = (convId: string, updatedSpecs: TechnicalSpec) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, specs: updatedSpecs } : c))
    );
  };

  const handleUpdateStatus = (convId: string, status: LeadStatus) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, status } : c))
    );
  };

  const handleToggleHideComment = (convId: string) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId ? { ...c, commentHidden: !c.commentHidden } : c
      )
    );
  };

  const handleExportProductionOrder = async (convId: string) => {
    const targetConv = conversations.find((c) => c.id === convId);
    if (!targetConv) return;

    const orderCode =
      targetConv.productionOrderCode ||
      `LSX-TP-${Math.floor(100000 + Math.random() * 900000)}`;

    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              savedOrder: true,
              productionOrderCode: orderCode,
            }
          : c
      )
    );

    // If staff is authenticated, persist the order to Cloud Firestore
    if (currentUser) {
      const pageObj = pages.find((p) => p.id === targetConv.pageId);
      const docId = `${currentUser.uid}_${orderCode}`;
      try {
        await setDoc(doc(db, 'orders', docId), {
          orderCode: orderCode.slice(0, 64),
          staffUid: currentUser.uid.slice(0, 128),
          staffEmail: (currentUser.email || 'staff@tienphat.vn').slice(0, 160),
          pageId: targetConv.pageId,
          pageName: (pageObj?.name || 'Xưởng Bao Bì Tiến Phát').slice(0, 120),
          customerName: targetConv.customerName.slice(0, 150),
          interactionType: targetConv.interactionType.slice(0, 64),
          status: targetConv.status,
          product: (targetConv.specs.product || 'Ấn phẩm in ấn').slice(0, 200),
          dimensions: (targetConv.specs.dimensions || 'Chưa xác định').slice(
            0,
            120
          ),
          quantity: (targetConv.specs.quantity || 'Chưa xác định').slice(
            0,
            120
          ),
          materialAndFinishing: (
            targetConv.specs.materialAndFinishing || 'Chưa xác định'
          ).slice(0, 250),
          designFileStatus: (
            targetConv.specs.designFileStatus || 'Chưa xác định'
          ).slice(0, 200),
          phoneOrZalo: (targetConv.specs.phoneOrZalo || 'Chưa có SĐT').slice(
            0,
            64
          ),
          deliveryAddress: (
            targetConv.specs.deliveryAddress || 'Chưa xác định'
          ).slice(0, 250),
          commentHidden: Boolean(targetConv.commentHidden),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, `orders/${docId}`);
      }
    }
  };

  const handleDeleteFirestoreOrder = async (orderId: string) => {
    try {
      await deleteDoc(doc(db, 'orders', orderId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `orders/${orderId}`);
    }
  };

  const moduleBreadcrumbs: Record<ActiveModule, string> = {
    dashboard: 'Hệ thống Tiến Phát AI / 1. Quản Lý 3 Fanpage & Firestore Database',
    inbox: 'Hệ thống Tiến Phát AI / 2. Hộp Thư & Bình Luận Tự Động AI (3 Cột)',
    'ai-rules': 'Hệ thống Tiến Phát AI / 3. Quy Tắc Bộ Não AI Ngành In (JSON Schema)',
    marketing: 'Hệ thống Tiến Phát AI / 4. Trợ Lý Viết Bài & Chăm Sóc Tự Động',
  };

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Desktop Sidebar */}
      <div className="hidden md:flex">
        <Sidebar
          activeModule={activeModule}
          onSelectModule={(mod) => setActiveModule(mod)}
          pages={pages}
          selectedPage={selectedPage}
          onSelectPage={(pageId) => setSelectedPage(pageId)}
          unreadInboxCount={conversations.length}
          autoPilot={autoPilot}
          onToggleAutoPilot={() => setAutoPilot((prev) => !prev)}
          currentUser={currentUser}
          authLoading={authLoading}
          onStaffLogin={handleStaffLogin}
          onStaffLogout={handleStaffLogout}
          savedOrdersCount={firestoreOrders.length}
          onOpenFacebookModal={() => setFbModalOpen(true)}
        />
      </div>

      {/* Mobile Sidebar Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative z-10 flex">
            <Sidebar
              activeModule={activeModule}
              onSelectModule={(mod) => {
                setActiveModule(mod);
                setMobileMenuOpen(false);
              }}
              pages={pages}
              selectedPage={selectedPage}
              onSelectPage={(pageId) => {
                setSelectedPage(pageId);
                setMobileMenuOpen(false);
              }}
              unreadInboxCount={conversations.length}
              autoPilot={autoPilot}
              onToggleAutoPilot={() => setAutoPilot((prev) => !prev)}
              currentUser={currentUser}
              authLoading={authLoading}
              onStaffLogin={handleStaffLogin}
              onStaffLogout={handleStaffLogout}
              savedOrdersCount={firestoreOrders.length}
              onOpenFacebookModal={() => {
                setMobileMenuOpen(false);
                setFbModalOpen(true);
              }}
            />
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb on Left, Action Buttons on Right */}
        <header className="h-14 bg-white border-b border-slate-200 px-5 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Mở menu điều hướng"
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="md:hidden p-1.5 text-slate-600 hover:text-slate-900 rounded-md"
            >
              {mobileMenuOpen ? (
                <X className="w-5 h-5" />
              ) : (
                <Menu className="w-5 h-5" />
              )}
            </button>
            <span className="text-xs font-semibold text-slate-600 truncate">
              {moduleBreadcrumbs[activeModule]}
            </span>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setFbModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-900 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Link2 className="w-3.5 h-3.5 text-blue-600" />
              <span>FB OAuth & Webhook</span>
            </button>

            <button
              type="button"
              onClick={() => setSimulateModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Giả lập khách nhắn mới</span>
            </button>
          </div>
        </header>

        {/* Active Module Viewport */}
        <main className="flex-1 overflow-y-auto">
          {activeModule === 'dashboard' && (
            <FanpageDashboard
              pages={pages}
              conversations={conversations}
              selectedPage={selectedPage}
              onSelectPage={(p) => setSelectedPage(p)}
              onUpdatePageName={handleUpdatePageName}
              onOpenInboxForPage={(p) => {
                setSelectedPage(p);
                setActiveModule('inbox');
              }}
              onOpenSimulateModal={() => setSimulateModalOpen(true)}
              onOpenFacebookModal={() => setFbModalOpen(true)}
              currentUser={currentUser}
              onStaffLogin={handleStaffLogin}
              firestoreOrders={firestoreOrders}
              onDeleteFirestoreOrder={handleDeleteFirestoreOrder}
            />
          )}

          {activeModule === 'inbox' && (
            <UnifiedInbox
              pages={pages}
              conversations={conversations}
              selectedPage={selectedPage}
              onSelectPage={(p) => setSelectedPage(p)}
              activeConversationId={activeConversationId}
              onSelectConversation={(id) => setActiveConversationId(id)}
              autoPilot={autoPilot}
              onToggleAutoPilot={() => setAutoPilot((prev) => !prev)}
              isAiProcessing={isAiProcessing}
              onSendCustomerMessage={handleSendCustomerMessage}
              onSendStaffReply={handleSendStaffReply}
              onTriggerAiReplyNow={handleTriggerAiReplyNow}
              onUpdateSpecs={handleUpdateSpecs}
              onUpdateStatus={handleUpdateStatus}
              onToggleHideComment={handleToggleHideComment}
              onExportProductionOrder={handleExportProductionOrder}
              onOpenSimulateModal={() => setSimulateModalOpen(true)}
            />
          )}

          {activeModule === 'ai-rules' && (
            <PrintingBrainRules
              onTestBrainPrompt={(payload) =>
                callServerAiAnalyze({
                  customerMessage: payload.customerMessage,
                  conversationHistory: [
                    { sender: 'customer', content: payload.customerMessage },
                  ],
                  currentSpecs: {
                    product: 'Chưa xác định',
                    dimensions: 'Chưa xác định',
                    quantity: 'Chưa xác định',
                    materialAndFinishing: 'Chưa xác định',
                    designFileStatus: 'Chưa xác định',
                    phoneOrZalo: 'Chưa có SĐT',
                    deliveryAddress: 'Chưa xác định',
                  },
                  interactionType: payload.interactionType,
                  pageId: payload.pageId,
                })
              }
            />
          )}

          {activeModule === 'marketing' && (
            <MarketingAssistant pages={pages} selectedPage={selectedPage} />
          )}
        </main>
      </div>

      {/* Simulate New Customer Message / Comment Modal */}
      <SimulateLeadModal
        isOpen={simulateModalOpen}
        onClose={() => setSimulateModalOpen(false)}
        pages={pages}
        onSimulateSubmit={handleSimulateNewLead}
      />

      {/* Facebook OAuth (Max 3 Fanpages) & Graph API Webhook Modal */}
      <FacebookOAuthWebhookModal
        isOpen={fbModalOpen}
        onClose={() => setFbModalOpen(false)}
        pages={pages}
        onConnectThreePages={handleConnectThreePages}
        onWebhookLeadReceived={handleWebhookLeadReceived}
        isStaffLoggedIn={Boolean(currentUser)}
      />
    </div>
  );
}

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline')
    ) {
      console.error('Please check your Firebase configuration.');
      return false;
    }
    // Permission denied on /test/connection means client is online and reaching Firestore
    return true;
  }
}

export {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
};
export type { User };

@import "tailwindcss";

@theme {
  --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
}

@layer base {
  body {
    font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    background-color: #f8fafc;
    color: #0f172a;
    -webkit-font-smoothing: antialiased;
  }

  code, pre, .font-mono {
    font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    font-variant-numeric: tabular-nums;
  }
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);

export type PageId = 'page1' | 'page2' | 'page3';

export type LeadStatus = 'Đã chốt SĐT' | 'Đang hỏi quy cách' | 'Cần báo giá';

export type InteractionType = 'Tin nhắn (Inbox)' | 'Bình luận (Comment)';

export interface FanpageConfig {
  id: PageId;
  name: string;
  specialty: string;
  products: string[];
  handledMessagesCount: number;
  collectedPhonesCount: number;
  pendingQuotesCount: number;
  fbPageId?: string;
  webhookSubscribed?: boolean;
  connectedViaOAuth?: boolean;
}

export interface TechnicalSpec {
  product: string;
  dimensions: string;
  quantity: string;
  materialAndFinishing: string;
  designFileStatus: string;
  phoneOrZalo: string;
  deliveryAddress: string;
}

export interface ChatMessage {
  id: string;
  sender: 'customer' | 'ai' | 'staff';
  content: string;
  timestamp: string;
  isComment?: boolean;
  isHiddenComment?: boolean;
}

export interface Conversation {
  id: string;
  pageId: PageId;
  customerName: string;
  customerHandle: string;
  interactionType: InteractionType;
  status: LeadStatus;
  commentHidden: boolean;
  savedOrder: boolean;
  productionOrderCode?: string;
  updatedAt: string;
  messages: ChatMessage[];
  specs: TechnicalSpec;
}

export interface AIAnalysisResult {
  replyMessage: string;
  status: LeadStatus;
  shouldHideComment: boolean;
  specs: TechnicalSpec;
}

export interface MarketingPostItem {
  id: string;
  pageId: PageId;
  topic: string;
  productFocus: string;
  tone: string;
  headline: string;
  content: string;
  hashtags: string[];
  cta: string;
  createdAt: string;
  status: 'Đã đăng tự động' | 'Lên lịch đăng' | 'Bản nháp';
  scheduledTime: string;
}

export interface FirestoreSavedOrder {
  id: string;
  orderCode: string;
  staffUid: string;
  staffEmail: string;
  pageId: PageId;
  pageName: string;
  customerName: string;
  interactionType: string;
  status: string;
  product: string;
  dimensions: string;
  quantity: string;
  materialAndFinishing: string;
  designFileStatus: string;
  phoneOrZalo: string;
  deliveryAddress: string;
  commentHidden: boolean;
  createdAtText: string;
}

export interface FacebookWebhookEventItem {
  id: string;
  receivedAt: string;
  fbPageId: string;
  mappedSlotId: PageId;
  mappedPageName: string;
  senderId: string;
  senderName: string;
  interactionType: InteractionType;
  incomingText: string;
  aiReply: string;
  status: LeadStatus;
  shouldHideComment: boolean;
  specs: TechnicalSpec;
  graphApiStatus: string;
}
