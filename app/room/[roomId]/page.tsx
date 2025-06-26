'use client';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useSocket } from '@/app/provider/socket';
import { Mic, MicOff, Video, VideoOff, ScreenShare, PhoneOff, RefreshCw, AlertTriangle } from 'lucide-react';

// Add TypeScript interface for Navigator.connection
interface NetworkInformation {
  effectiveType: string;
  downlink: number;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

// Extend Navigator interface
interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
}

// Helper to get email and roomId from URL query parameters
const getEmailAndRoom = () => {
  if (typeof window === 'undefined') return { myEmail: '', roomId: '' };
  const url = new URL(window.location.href);
  const myEmail = url.searchParams.get('email') || '';
  const roomId = url.pathname.split('/').pop() || '';
  return { myEmail, roomId };
};

const MAX_RECONNECT_ATTEMPTS = 2; // Lowered for stability

const RoomPage: React.FC = () => {
  const socket = useSocket();
  const [peer, setPeer] = useState<RTCPeerConnection | null>(null);
  const [myStream, setMyStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteEmailId, setRemoteEmailId] = useState<string | null>(null);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [connectionState, setConnectionState] = useState<string>('new');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [showReconnectMessage, setShowReconnectMessage] = useState(false);
  const [mediaStalled, setMediaStalled] = useState(false);

  // Refs
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const isInitiatorRef = useRef<boolean>(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteEmailIdRef = useRef<string | null>(null);
  const myStreamRef = useRef<MediaStream | null>(null);
  const negotiationNeededRef = useRef<boolean>(false);
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const lastBytesReceivedRef = useRef<{[key: string]: number}>({});
  const stallDetectionTimerRef = useRef<NodeJS.Timeout | null>(null);
  const stallCountRef = useRef<number>(0);

  const { myEmail, roomId } = getEmailAndRoom();

  // Logger function - keeps logging in console but not UI
  const log = useCallback((message: string) => {
    // You can replace this with a custom logger if needed
    console.log(message);
  }, []);

  // Forward declare function references to avoid circular dependencies
  const attemptReconnectionRef = useRef<() => void>(() => {});

  // Create peer connection with robust ICE servers
  const createPeerConnection = useCallback(() => {
    log('[PEER] Creating new RTCPeerConnection...');

    // Close existing connection if any
    if (peerRef.current) {
      peerRef.current.close();
    }

    const navigatorWithConnection = navigator as NavigatorWithConnection;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302'] },
        {
          urls: ['turn:global.xirsys.net:3478?transport=udp', 'turn:global.xirsys.net:3478?transport=tcp'],
          username: 'fahadfarman',
          credential: '098acec2-51ce-11f0-8544-0242ac150002'
        }
      ],
      iceCandidatePoolSize: 10,
      iceTransportPolicy: navigatorWithConnection.connection?.effectiveType === '2g' ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    pc.onconnectionstatechange = () => {
      log(`[PEER] Connection state changed to: ${pc.connectionState}`);
      setConnectionState(pc.connectionState);

      if (pc.connectionState === 'connected') {
        log('[PEER] Connection established successfully');
        if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
        reconnectAttemptsRef.current = 0;
        setIsReconnecting(false);
        setShowReconnectMessage(false);
        setMediaStalled(false);
        stallCountRef.current = 0;
        startTrackStatsMonitoring();
      }
      else if (pc.connectionState === 'failed') {
        log('[PEER] Connection failed, will attempt reconnection');
        setShowReconnectMessage(true);
        attemptReconnectionRef.current();
      }
      else if (pc.connectionState === 'disconnected') {
        log('[PEER] Connection disconnected, waiting to see if it recovers...');
        setShowReconnectMessage(true);
        if (!connectionTimeoutRef.current) {
          connectionTimeoutRef.current = setTimeout(() => {
            if (pc.connectionState === 'disconnected') {
              log('[PEER] Connection still disconnected, attempting reconnection');
              attemptReconnectionRef.current();
            }
          }, 5000);
        }
      }
    };

    pc.ontrack = (event) => {
      log(`[PEER] Received remote ${event.track.kind} track: ${event.track.id}`);
      let stream: MediaStream;
      if (event.streams && event.streams[0]) {
        stream = event.streams[0];
        stream.getTracks().forEach(track => {
          if (track.kind === 'audio') track.enabled = true;
        });
      } else {
        if (remoteVideoRef.current && remoteVideoRef.current.srcObject instanceof MediaStream) {
          stream = remoteVideoRef.current.srcObject as MediaStream;
          const existingTrack = stream.getTracks().find(t => t.id === event.track.id);
          if (!existingTrack) stream.addTrack(event.track);
        } else {
          stream = new MediaStream();
          stream.addTrack(event.track);
        }
        if (event.track.kind === 'audio') event.track.enabled = true;
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        remoteVideoRef.current.muted = false;
        remoteVideoRef.current.play().catch(() => {});
      }
      setRemoteStream(stream);
      setMediaStalled(false);
      stallCountRef.current = 0;
      if (event.track && event.track.id) lastBytesReceivedRef.current[event.track.id] = 0;
    };

    pc.oniceconnectionstatechange = () => {
      log(`[ICE] ICE connection state changed to: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        log('[ICE] ICE connection failed, restarting ICE');
        setShowReconnectMessage(true);
        try {
          pc.restartIce();
        } catch {
          attemptReconnectionRef.current();
        }
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && remoteEmailIdRef.current && socket) {
        socket.emit('ice-candidate', {
          emailId: remoteEmailIdRef.current,
          candidate: event.candidate
        });
      }
    };

    pc.onnegotiationneeded = () => {
      negotiationNeededRef.current = true;
      if (isInitiatorRef.current && remoteEmailIdRef.current) handleNegotiationNeeded();
    };

    peerRef.current = pc;
    setPeer(pc);
    return pc;
  }, [socket, log]);

  // Track stats monitoring for stall detection
  const startTrackStatsMonitoring = useCallback(() => {
    if (stallDetectionTimerRef.current) clearInterval(stallDetectionTimerRef.current);
    if (!peerRef.current) return;

    stallDetectionTimerRef.current = setInterval(async () => {
      if (!peerRef.current || peerRef.current.connectionState !== 'connected') return;
      try {
        const stats = await peerRef.current.getStats();
        let hasStall = false;
        stats.forEach(stat => {
          if (stat.type === 'inbound-rtp' && 'bytesReceived' in stat) {
            const trackId = stat.trackId || '';
            const bytesReceived = stat.bytesReceived as number;
            if (lastBytesReceivedRef.current[trackId] !== undefined) {
              if (lastBytesReceivedRef.current[trackId] === bytesReceived) hasStall = true;
            }
            lastBytesReceivedRef.current[trackId] = bytesReceived;
          }
        });
        if (hasStall && peerRef.current.connectionState === 'connected') {
          stallCountRef.current += 1;
          if (stallCountRef.current > 2) {
            setMediaStalled(true);
            setShowReconnectMessage(true);
            if (!isReconnecting) attemptReconnectionRef.current();
          }
        } else {
          stallCountRef.current = 0;
          if (mediaStalled) setMediaStalled(false);
        }
      } catch {}
    }, 3000);

    return () => {
      if (stallDetectionTimerRef.current) clearInterval(stallDetectionTimerRef.current);
    };
  }, [isReconnecting, mediaStalled]);

  // Function to handle negotiation needed event
  const handleNegotiationNeeded = useCallback(async () => {
    if (!peerRef.current || !remoteEmailIdRef.current || !socket || !isInitiatorRef.current) return;
    negotiationNeededRef.current = false;
    try {
      const offer = await peerRef.current.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await peerRef.current.setLocalDescription(offer);
      socket.emit('call-user', {
        emailId: remoteEmailIdRef.current,
        offer: peerRef.current.localDescription
      });
    } catch {}
  }, [socket]);

  // Add tracks to peer connection from local stream
  const addTracksToConnection = useCallback((pc: RTCPeerConnection, stream: MediaStream) => {
    const senders = pc.getSenders();
    senders.forEach(sender => {
      try {
        if (sender.track) pc.removeTrack(sender);
      } catch {}
    });
    stream.getTracks().forEach(track => {
      try {
        pc.addTrack(track, stream);
        if (track.kind === 'audio') track.enabled = audioEnabled;
        else if (track.kind === 'video') track.enabled = videoEnabled;
      } catch {}
    });
  }, [audioEnabled, videoEnabled]);

  // Get local media stream
  useEffect(() => {
    let isMounted = true;
    const getMediaStream = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: { echoCancellation: true, noiseSuppression: true }
        });
        if (!isMounted) return;
        setMyStream(stream);
        myStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        if (peerRef.current) addTracksToConnection(peerRef.current, stream);
      } catch {
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          if (!isMounted) return;
          setMyStream(audioStream);
          myStreamRef.current = audioStream;
          if (peerRef.current) addTracksToConnection(peerRef.current, audioStream);
        } catch {}
      }
    };
    getMediaStream();
    return () => { isMounted = false; };
  }, [addTracksToConnection]);

  // Join room when socket is ready
  useEffect(() => {
    if (socket && myEmail && roomId) socket.emit('join-room', { roomId, emailId: myEmail });
  }, [socket, myEmail, roomId]);

  // Improved reconnection logic with strong connection approach
  const attemptReconnection = useCallback(() => {
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      log('[RECONNECT] Maximum reconnection attempts reached. Please check your network.');
      setShowReconnectMessage(true);
      setIsReconnecting(false);
      return;
    }
    reconnectAttemptsRef.current += 1;
    setIsReconnecting(true);

    // Reset stats monitoring
    lastBytesReceivedRef.current = {};
    if (stallDetectionTimerRef.current) clearInterval(stallDetectionTimerRef.current);

    if (remoteEmailIdRef.current && socket) {
      socket.emit('reconnect-request', {
        emailId: remoteEmailIdRef.current,
        from: myEmail
      });

      if (peerRef.current) peerRef.current.close();
      const pc = createPeerConnection();
      isInitiatorRef.current = true;

      const refreshTracks = async () => {
        try {
          // Don't restart media devices on reconnection for strong connection; only restart peer connection
          if (myStreamRef.current) {
            addTracksToConnection(pc, myStreamRef.current);
          }
          setTimeout(async () => {
            try {
              if (peerRef.current && remoteEmailIdRef.current) {
                const offer = await peerRef.current.createOffer({
                  offerToReceiveAudio: true,
                  offerToReceiveVideo: true,
                  iceRestart: true
                });
                await peerRef.current.setLocalDescription(offer);
                socket.emit('call-user', {
                  emailId: remoteEmailIdRef.current,
                  offer: peerRef.current.localDescription
                });
              }
            } catch {}
          }, 600);
        } catch {}
      };

      refreshTracks();
    }
  }, [socket, myEmail, createPeerConnection, addTracksToConnection]);

  useEffect(() => {
    attemptReconnectionRef.current = attemptReconnection;
  }, [attemptReconnection]);

  // Setup socket event handlers
  useEffect(() => {
    if (!socket) return;

    const handleRoomJoined = ({ otherUsers }: { otherUsers: string[] }) => {
      if (otherUsers && otherUsers.length > 0) {
        const remoteUser = otherUsers[0];
        setRemoteEmailId(remoteUser);
        remoteEmailIdRef.current = remoteUser;
        isInitiatorRef.current = true;
        const pc = createPeerConnection();
        if (myStreamRef.current) {
          addTracksToConnection(pc, myStreamRef.current);
          setTimeout(async () => {
            if (!pc.localDescription) {
              try {
                const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
                await pc.setLocalDescription(offer);
                socket.emit('call-user', {
                  emailId: remoteUser,
                  offer: pc.localDescription
                });
              } catch {}
            }
          }, 600);
        }
      } else {
        isInitiatorRef.current = false;
        createPeerConnection();
      }
    };

    const handleIncomingCall = async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      setRemoteEmailId(from);
      remoteEmailIdRef.current = from;
      const pc = peerRef.current || createPeerConnection();
      try {
        if (myStreamRef.current) addTracksToConnection(pc, myStreamRef.current);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        if (pendingCandidatesRef.current.length > 0) {
          for (const candidate of pendingCandidatesRef.current) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
          }
          pendingCandidatesRef.current = [];
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call-accepted', {
          emailId: from,
          answer: pc.localDescription
        });
      } catch {}
    };

    const handleCallAccepted = async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
      if (peerRef.current) {
        try {
          await peerRef.current.setRemoteDescription(new RTCSessionDescription(answer));
          if (pendingCandidatesRef.current.length > 0) {
            for (const candidate of pendingCandidatesRef.current) {
              await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
            }
            pendingCandidatesRef.current = [];
          }
          connectionTimeoutRef.current = setTimeout(() => {
            if (peerRef.current && peerRef.current.connectionState !== 'connected') {
              setShowReconnectMessage(true);
              attemptReconnectionRef.current();
            }
          }, 10000);
        } catch {}
      }
    };

    const handleIceCandidate = async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      if (peerRef.current) {
        if (peerRef.current.remoteDescription) {
          try {
            await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          } catch {
            pendingCandidatesRef.current.push(candidate);
          }
        } else {
          pendingCandidatesRef.current.push(candidate);
        }
      } else {
        pendingCandidatesRef.current.push(candidate);
      }
    };

    const handleUserJoined = ({ emailId }: { emailId: string }) => {
      if (emailId !== myEmail) {
        setRemoteEmailId(emailId);
        remoteEmailIdRef.current = emailId;
      }
    };

    const handleUserLeft = ({ emailId }: { emailId: string }) => {
      if (emailId === remoteEmailIdRef.current) {
        setRemoteEmailId(null);
        remoteEmailIdRef.current = null;
        setRemoteStream(null);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        if (peerRef.current) {
          peerRef.current.close();
          createPeerConnection();
        }
      }
    };

    const handleReconnectRequest = ({ from }: { from: string }) => {
      setRemoteEmailId(from);
      remoteEmailIdRef.current = from;
      if (peerRef.current) peerRef.current.close();
      const pc = createPeerConnection();
      if (myStreamRef.current) {
        addTracksToConnection(pc, myStreamRef.current);
        isInitiatorRef.current = true;
        setTimeout(async () => {
          try {
            const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
            await pc.setLocalDescription(offer);
            socket.emit('call-user', {
              emailId: from,
              offer: pc.localDescription
            });
          } catch {}
        }, 600);
      }
    };

    socket.on('room-joined', handleRoomJoined);
    socket.on('incoming-call', handleIncomingCall);
    socket.on('call-accepted', handleCallAccepted);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);
    socket.on('reconnect-request', handleReconnectRequest);

    return () => {
      socket.off('room-joined', handleRoomJoined);
      socket.off('incoming-call', handleIncomingCall);
      socket.off('call-accepted', handleCallAccepted);
      socket.off('ice-candidate', handleIceCandidate);
      socket.off('user-joined', handleUserJoined);
      socket.off('user-left', handleUserLeft);
      socket.off('reconnect-request', handleReconnectRequest);
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    };
  }, [socket, createPeerConnection, addTracksToConnection, myEmail]);

  // Make sure remote video element is updated when remoteStream changes
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
      remoteVideoRef.current.muted = false;
      remoteVideoRef.current.volume = 1.0;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (remoteEmailId && remoteVideoRef.current) {
      const checkAudioTimer = setTimeout(() => {}, 2000);
      return () => clearTimeout(checkAudioTimer);
    }
  }, [remoteEmailId]);

  useEffect(() => {
    return () => {
      if (peerRef.current) peerRef.current.close();
      if (myStreamRef.current) myStreamRef.current.getTracks().forEach(track => track.stop());
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      if (stallDetectionTimerRef.current) clearInterval(stallDetectionTimerRef.current);
    };
  }, []);

  // Media controls
  const handleScreenShare = useCallback(async () => {
    if (!peerRef.current || !myStreamRef.current) return;
    if (!isScreenSharing) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'monitor' as DisplayCaptureSurfaceType } });
        if (screenTrackRef.current) screenTrackRef.current.stop();
        const videoTrack = screenStream.getVideoTracks()[0];
        screenTrackRef.current = videoTrack;
        const sender = peerRef.current.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(videoTrack);
        else peerRef.current.addTrack(videoTrack, screenStream);
        setIsScreenSharing(true);
      } catch {}
    } else {
      if (peerRef.current && screenTrackRef.current) {
        screenTrackRef.current.stop();
        screenTrackRef.current = null;
        const originalVideoTrack = myStreamRef.current?.getVideoTracks()[0];
        if (originalVideoTrack) {
          const sender = peerRef.current.getSenders().find(s => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(originalVideoTrack);
        }
        setIsScreenSharing(false);
      }
    }
  }, [isScreenSharing]);

  const handleManualReconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    if (peerRef.current && peerRef.current.connectionState !== 'failed') {
      try {
        peerRef.current.createOffer({ iceRestart: true })
          .then(offer => peerRef.current!.setLocalDescription(offer))
          .then(() => {
            if (remoteEmailIdRef.current && socket) {
              socket.emit('call-user', {
                emailId: remoteEmailIdRef.current,
                offer: peerRef.current!.localDescription
              });
            }
          })
          .catch(() => {
            attemptReconnectionRef.current();
          });
      } catch {
        attemptReconnectionRef.current();
      }
    } else {
      attemptReconnectionRef.current();
    }
  }, [socket]);

  const handleToggleVideo = useCallback(() => {
    if (myStreamRef.current) {
      const videoTracks = myStreamRef.current.getVideoTracks();
      const newState = !videoEnabled;
      videoTracks.forEach(track => { track.enabled = newState; });
      setVideoEnabled(newState);
    }
  }, [videoEnabled]);

  const handleToggleAudio = useCallback(() => {
    if (myStreamRef.current) {
      const audioTracks = myStreamRef.current.getAudioTracks();
      const newState = !audioEnabled;
      audioTracks.forEach(track => { track.enabled = newState; });
      setAudioEnabled(newState);
    }
  }, [audioEnabled]);

  const handleEndCall = useCallback(() => {
    if (myStreamRef.current) myStreamRef.current.getTracks().forEach(track => track.stop());
    if (peerRef.current) peerRef.current.close();
    window.location.href = '/';
  }, []);

  return (
    <div className="flex flex-col min-h-screen bg-gradient-to-br from-blue-900 to-purple-900 text-white">
      <header className="px-6 py-4 bg-black/20 backdrop-blur-sm shadow-lg">
        <h1 className="text-2xl font-bold text-center">Video Call: Room {roomId}</h1>
      </header>
      {showReconnectMessage && (
        <div className="bg-yellow-600 text-white px-4 py-3 flex items-center justify-center gap-2 animate-pulse">
          <AlertTriangle size={20} />
          <span className="font-medium">
            {isReconnecting ?
              'Connection issue detected. Reconnecting...' :
              mediaStalled ? 'Video appears frozen. Please click Reconnect' :
              'Connection unstable. Please click Reconnect if issues persist'}
          </span>
        </div>
      )}
      <main className="flex-1 flex flex-col md:flex-row items-center justify-center gap-8 p-6">
        {/* Local Video */}
        <div className="bg-black/30 backdrop-blur-sm rounded-xl shadow-xl overflow-hidden border border-white/10 transition-all duration-300 w-full max-w-xl">
          <div className="p-3 bg-black/40 border-b border-white/10">
            <h2 className="text-center font-medium">
              You ({myEmail})
            </h2>
          </div>
          <div className="relative aspect-video bg-black">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            {!myStream && (
              <div className="absolute inset-0 flex items-center justify-center text-gray-400">
                <span className="bg-black/50 px-3 py-1 rounded-full text-sm">Connecting camera...</span>
              </div>
            )}
            <div className="absolute bottom-3 left-3 bg-black/50 px-2 py-1 rounded text-xs">
              {videoEnabled ? 'Camera ON' : 'Camera OFF'}
            </div>
          </div>
        </div>
        {/* Remote Video */}
        <div className="bg-black/30 backdrop-blur-sm rounded-xl shadow-xl overflow-hidden border border-white/10 transition-all duration-300 w-full max-w-xl">
          <div className="p-3 bg-black/40 border-b border-white/10">
            <h2 className="text-center font-medium">
              {remoteEmailId ? `${remoteEmailId}` : 'Waiting for someone to join...'}
            </h2>
          </div>
          <div className="relative aspect-video bg-black">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />
            {!remoteStream && (
              <div className="absolute inset-0 flex items-center justify-center">
                {!remoteEmailId ? (
                  <div className="bg-black/50 px-4 py-2 rounded-lg text-center">
                    <p>No remote video</p>
                    <p className="text-sm text-gray-400 mt-1">Waiting for participant to connect</p>
                  </div>
                ) : (
                  <div className="w-full h-full p-4">
                    <div className="flex flex-wrap justify-center gap-4 h-full">
                      <div className="bg-black/40 rounded-lg flex items-center justify-center p-3" style={{ minWidth: '160px' }}>
                        <div className="text-center">
                          <div className="w-16 h-16 bg-blue-700 rounded-full mb-2 mx-auto flex items-center justify-center">
                            <span className="text-lg font-bold">{myEmail.substring(0, 2).toUpperCase()}</span>
                          </div>
                          <p className="text-sm text-gray-300 truncate max-w-[120px]">{myEmail}</p>
                          <p className="text-xs text-green-400">You (Connected)</p>
                        </div>
                      </div>
                      {remoteEmailId && (
                        <div className="bg-black/40 rounded-lg flex items-center justify-center p-3" style={{ minWidth: '160px' }}>
                          <div className="text-center">
                            <div className="w-16 h-16 bg-purple-700 rounded-full mb-2 mx-auto flex items-center justify-center animate-pulse">
                              <span className="text-lg font-bold">{remoteEmailId.substring(0, 2).toUpperCase()}</span>
                            </div>
                            <p className="text-sm text-gray-300 truncate max-w-[120px]">{remoteEmailId}</p>
                            <p className="text-xs text-yellow-400">Connecting...</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
      <footer className="flex flex-col items-center justify-center p-6 bg-black/30 backdrop-blur-md">
        <div className="flex items-center gap-6 mb-4">
          <button
            onClick={handleToggleAudio}
            className={`p-4 rounded-full transition-all duration-300 shadow-lg ${
              audioEnabled ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700'
            }`}
            title={audioEnabled ? "Mute microphone" : "Unmute microphone"}
          >
            {audioEnabled ? <Mic size={24} /> : <MicOff size={24} />}
          </button>
          <button
            onClick={handleEndCall}
            className="p-5 bg-red-600 hover:bg-red-700 rounded-full transition-all duration-300 shadow-lg transform hover:scale-110"
            title="End call"
          >
            <PhoneOff size={28} />
          </button>
          <button
            onClick={handleToggleVideo}
            className={`p-4 rounded-full transition-all duration-300 shadow-lg ${
              videoEnabled ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700'
            }`}
            title={videoEnabled ? "Turn off camera" : "Turn on camera"}
          >
            {videoEnabled ? <Video size={24} /> : <VideoOff size={24} />}
          </button>
        </div>
        <div className="flex gap-4">
          <button
            onClick={handleScreenShare}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all duration-300 font-medium ${
              isScreenSharing ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'
            }`}
            disabled={!peer || connectionState !== 'connected'}
            title={!peer ? "Connection not established" : "Share your screen"}
          >
            <ScreenShare size={20} />
            {isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
          </button>
          <button
            onClick={handleManualReconnect}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all duration-300 ${
              isReconnecting ? 'bg-yellow-500 animate-pulse' : showReconnectMessage ? 'bg-yellow-600 hover:bg-yellow-700 animate-bounce' : 'bg-gray-700 hover:bg-gray-600'
            }`}
            title="Fix connection issues"
          >
            <RefreshCw size={20} className={isReconnecting ? 'animate-spin' : ''} />
            {isReconnecting ? 'Joining...' : 'Join Room'}
          </button>
        </div>
      </footer>
    </div>
  );
};

export default RoomPage;