'use client';
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";

interface PeerContextType {
    peer: RTCPeerConnection | null;
    createOffer: () => Promise<RTCSessionDescriptionInit | undefined>;
    createAnswer: (offer: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit | undefined>;
    setRemoteDescription: (desc: RTCSessionDescriptionInit) => Promise<void>;
    sendStream: (stream: MediaStream) => void;
    remoteStream: MediaStream | null;
    addIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>;
    connectionState: string;
    resetConnection: () => void;
}

const PeerContext = React.createContext<PeerContextType | null>(null);

export const usePeer = () => {
    const context = React.useContext(PeerContext);
    if (!context) {
        throw new Error("usePeer must be used within a PeerProvider");
    }
    return context;
};

export const PeerProvider = ({ children }: { children: React.ReactNode }) => {
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
    const [connectionState, setConnectionState] = useState<string>('new');
    const [peer, setPeer] = useState<RTCPeerConnection | null>(null);
    
    const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
    const localStreamRef = useRef<MediaStream | null>(null);
    const isConnectionInitializedRef = useRef(false);

    // Create peer connection
    const createPeerConnection = useCallback(() => {
        if (typeof window === 'undefined') return null;
        
        console.log('[PEER_PROVIDER] Creating new RTCPeerConnection');
        
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: ["stun:stun.l.google.com:19302"] },
                { urls: ["stun:global.stun.twilio.com:3478"] }
            ],
        });

        // Handle remote tracks
        pc.ontrack = (event) => {
            console.log('[PEER_PROVIDER] Received remote track:', event.track.kind);
            
            if (event.streams && event.streams[0]) {
                setRemoteStream(event.streams[0]);
                console.log('[PEER_PROVIDER] Set remote stream from event.streams[0]');
            } else {
                // Fallback: create stream manually
                const stream = new MediaStream([event.track]);
                setRemoteStream(stream);
                console.log('[PEER_PROVIDER] Created manual remote stream for track:', event.track.kind);
            }
        };

        // Handle connection state changes
        pc.onconnectionstatechange = () => {
            console.log('[PEER_PROVIDER] Connection state changed to:', pc.connectionState);
            setConnectionState(pc.connectionState);
            
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                console.warn('[PEER_PROVIDER] Connection failed or disconnected');
                setRemoteStream(null);
            }
        };

        // Handle ICE connection state changes
        pc.oniceconnectionstatechange = () => {
            console.log('[PEER_PROVIDER] ICE connection state:', pc.iceConnectionState);
        };

        // Handle signaling state changes
        pc.onsignalingstatechange = () => {
            console.log('[PEER_PROVIDER] Signaling state:', pc.signalingState);
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('[PEER_PROVIDER] Local ICE candidate generated:', event.candidate.candidate);
            } else {
                console.log('[PEER_PROVIDER] ICE candidate gathering complete');
            }
        };

        setPeer(pc);
        return pc;
    }, []);

    // Initialize peer connection
    useEffect(() => {
        if (!isConnectionInitializedRef.current) {
            createPeerConnection();
            isConnectionInitializedRef.current = true;
        }

        return () => {
            // Cleanup on unmount
            if (peer && peer.connectionState !== 'closed') {
                console.log('[PEER_PROVIDER] Cleaning up peer connection');
                peer.close();
            }
        };
    }, []);

    // Send local stream
    const sendStream = useCallback((stream: MediaStream) => {
        if (!peer) {
            console.error('[PEER_PROVIDER] Cannot send stream: peer connection not available');
            return;
        }

        // Remove existing tracks first
        peer.getSenders().forEach(sender => {
            if (sender.track) {
                peer.removeTrack(sender);
            }
        });

        // Add new tracks
        console.log('[PEER_PROVIDER] Adding local tracks to peer connection');
        stream.getTracks().forEach(track => {
            peer.addTrack(track, stream);
            console.log(`[PEER_PROVIDER] Added ${track.kind} track:`, track.id);
        });

        localStreamRef.current = stream;
    }, [peer]);

    // Create offer
    const createOffer = useCallback(async () => {
        if (!peer) {
            console.error('[PEER_PROVIDER] Cannot create offer: peer connection not available');
            return;
        }

        try {
            console.log('[PEER_PROVIDER] Creating offer...');
            const offer = await peer.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
            await peer.setLocalDescription(offer);
            console.log('[PEER_PROVIDER] Offer created and set as local description');
            return offer;
        } catch (err) {
            console.error('[PEER_PROVIDER] Error creating offer:', err);
            throw err;
        }
    }, [peer]);

    // Create answer
    const createAnswer = useCallback(async (offer: RTCSessionDescriptionInit) => {
        if (!peer) {
            console.error('[PEER_PROVIDER] Cannot create answer: peer connection not available');
            return;
        }

        try {
            console.log('[PEER_PROVIDER] Setting remote description and creating answer');
            await peer.setRemoteDescription(new RTCSessionDescription(offer));
            
            // Process any pending ICE candidates
            while (pendingCandidatesRef.current.length > 0) {
                const candidate = pendingCandidatesRef.current.shift();
                if (candidate) {
                    try {
                        await peer.addIceCandidate(new RTCIceCandidate(candidate));
                        console.log('[PEER_PROVIDER] Added pending ICE candidate');
                    } catch (err) {
                        console.error('[PEER_PROVIDER] Error adding pending ICE candidate:', err);
                    }
                }
            }

            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            console.log('[PEER_PROVIDER] Answer created and set as local description');
            return answer;
        } catch (err) {
            console.error('[PEER_PROVIDER] Error creating answer:', err);
            throw err;
        }
    }, [peer]);

    // Set remote description
    const setRemoteDescription = useCallback(async (desc: RTCSessionDescriptionInit) => {
        if (!peer) {
            console.error('[PEER_PROVIDER] Cannot set remote description: peer connection not available');
            return;
        }

        try {
            console.log('[PEER_PROVIDER] Setting remote description:', desc.type);
            await peer.setRemoteDescription(new RTCSessionDescription(desc));
            
            // Process any pending ICE candidates
            while (pendingCandidatesRef.current.length > 0) {
                const candidate = pendingCandidatesRef.current.shift();
                if (candidate) {
                    try {
                        await peer.addIceCandidate(new RTCIceCandidate(candidate));
                        console.log('[PEER_PROVIDER] Added pending ICE candidate');
                    } catch (err) {
                        console.error('[PEER_PROVIDER] Error adding pending ICE candidate:', err);
                    }
                }
            }
            
            console.log('[PEER_PROVIDER] Remote description set successfully');
        } catch (err) {
            console.error('[PEER_PROVIDER] Error setting remote description:', err);
            throw err;
        }
    }, [peer]);

    // Add ICE candidate
    const addIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
        if (!peer) {
            console.error('[PEER_PROVIDER] Cannot add ICE candidate: peer connection not available');
            return;
        }

        try {
            if (peer.remoteDescription && peer.remoteDescription.type) {
                await peer.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('[PEER_PROVIDER] ICE candidate added successfully');
            } else {
                console.log('[PEER_PROVIDER] Queuing ICE candidate (no remote description yet)');
                pendingCandidatesRef.current.push(candidate);
            }
        } catch (err) {
            console.error('[PEER_PROVIDER] Error adding ICE candidate:', err);
        }
    }, [peer]);

    // Reset connection
    const resetConnection = useCallback(() => {
        console.log('[PEER_PROVIDER] Resetting peer connection');
        
        if (peer && peer.connectionState !== 'closed') {
            peer.close();
        }
        
        setRemoteStream(null);
        setConnectionState('new');
        pendingCandidatesRef.current = [];
        
        // Create new connection
        const newPeer = createPeerConnection();
        
        // Re-add local stream if available
        if (localStreamRef.current && newPeer) {
            localStreamRef.current.getTracks().forEach(track => {
                newPeer.addTrack(track, localStreamRef.current!);
            });
        }
    }, [peer, createPeerConnection]);

    const providerValue = useMemo(() => ({
        peer,
        createOffer,
        createAnswer,
        setRemoteDescription,
        sendStream,
        remoteStream,
        addIceCandidate,
        connectionState,
        resetConnection
    }), [
        peer,
        createOffer,
        createAnswer,
        setRemoteDescription,
        sendStream,
        remoteStream,
        addIceCandidate,
        connectionState,
        resetConnection
    ]);

    return (
        <PeerContext.Provider value={providerValue}>
            {children}
        </PeerContext.Provider>
    );
}; 