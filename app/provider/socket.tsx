'use client';
import React, { useMemo, useEffect } from "react";
import { io, Socket } from "socket.io-client";

const SocketContext = React.createContext<Socket | null>(null);

export const useSocket = () => {
  return React.useContext(SocketContext);
};

export const SocketProvider = ({ children }: { children: React.ReactNode }) => {
  const socket = useMemo(() => {
    if (typeof window !== 'undefined') {
      const newSocket = io('http://localhost:3002', {
        transports: ['websocket'],
        autoConnect: true,
        forceNew: true,
      });
      
      // Add connection event listeners for debugging
      newSocket.on('connect', () => {
        console.log('[SOCKET] Connected to server:', newSocket.id);
      });
      
      newSocket.on('disconnect', () => {
        console.log('[SOCKET] Disconnected from server');
      });
      
      newSocket.on('connect_error', (error) => {
        console.error('[SOCKET] Connection error:', error);
      });
      
      return newSocket;
    }
    return null;
  }, []);

  useEffect(() => {
    return () => {
      if (socket) {
        console.log('[SOCKET] Cleaning up socket connection');
        socket.disconnect();
      }
    };
  }, [socket]);

  return (
    <SocketContext.Provider value={socket}>
      {children}
    </SocketContext.Provider>
  );
};